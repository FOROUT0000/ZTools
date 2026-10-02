import { app } from 'electron'
import pluginDeviceAPI from '../../api/plugin/device'
import { httpRequest } from '../../utils/httpRequest'
import { OFFICIAL_SERVER_HTTP_URL, OFFICIAL_SYNC_SERVER_URL } from '../../../shared/syncServerUrl'
import {
  loadOfficialAccountSession,
  refreshOfficialAccountTokens
} from '../account/officialAccountService'
import type { CredentialSession } from '../auth/credentialSessionService'

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000

class ActivityHeartbeatService {
  private timer: NodeJS.Timeout | null = null
  private inFlight = false

  start(): void {
    if (this.timer) return
    void this.sendHeartbeat()
    this.timer = setInterval(() => {
      void this.sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 立即触发一次官方服务心跳；E2E 模式跳过真实网络请求以保持测试隔离。
   * @returns 无返回值。
   */
  runNow(): void {
    if (process.env.ZTOOLS_E2E === '1') return
    void this.sendHeartbeat()
  }

  /**
   * 上报当前设备活跃状态，并在访问令牌过期时通过统一服务刷新后重试一次。
   * @returns 上报完成后的 Promise。
   */
  private async sendHeartbeat(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const config = await this.loadConfig()
      const response = await this.postHeartbeat(config)
      if (response !== 401) return
      const refreshed = await refreshOfficialAccountTokens(config?.refreshToken)
      if (
        (refreshed.status === 'refreshed' || refreshed.status === 'reused') &&
        refreshed.session.token
      ) {
        await this.postHeartbeat(refreshed.session)
      } else if (refreshed.status === 'invalid') {
        // 登录凭据确认失效后仍以匿名心跳记录设备活跃。
        await this.postHeartbeat(null)
      }
    } catch (error) {
      console.warn('[ActivityHeartbeat] 上报失败:', error)
    } finally {
      this.inFlight = false
    }
  }

  /**
   * 向官方服务端提交当前设备的活跃心跳和 ZTools 版本。
   * @param config 当前同步账号配置；未登录时为 null
   * @returns 服务端返回的 HTTP 状态码。
   */
  private async postHeartbeat(config: CredentialSession | null): Promise<number> {
    const deviceId = pluginDeviceAPI.getDeviceIdPublic()
    const token = config?.serverUrl === OFFICIAL_SYNC_SERVER_URL ? config.token : ''

    // 使用 Electron 实际应用版本，确保开发和打包环境的上报来源一致。
    const ztoolsVersion = app.getVersion()
    const response = await httpRequest(`${OFFICIAL_SERVER_HTTP_URL}/api/activity/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        deviceId,
        uid: token ? config?.username || '' : '',
        ztoolsVersion
      }),
      validateStatus: (status) => (status >= 200 && status < 300) || status === 401
    })
    return response.status
  }

  /**
   * 从设备级路由存储读取心跳所需的账号配置。
   * @returns 当前配置；读取失败或未配置时返回 null。
   */
  private async loadConfig(): Promise<CredentialSession | null> {
    return loadOfficialAccountSession()
  }
}

export default new ActivityHeartbeatService()
