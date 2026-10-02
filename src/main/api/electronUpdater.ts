import path from 'path'
import { app } from 'electron'
import { CancellationToken } from 'builder-util-runtime'
import log from 'electron-log'
import { NsisUpdater, autoUpdater, type UpdateInfo } from 'electron-updater'
import type {
  PlatformDownloadStatus,
  PlatformUpdateActionResult,
  PlatformUpdateInfo,
  PlatformUpdateResult,
  PlatformUpdaterCallbacks
} from './platformUpdater/types'

export type ElectronUpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'not-available'
  | 'error'

/**
 * 将 electron-updater 的发布说明统一转换为界面可展示的纯文本。
 * @param releaseNotes electron-updater 返回的发布说明。
 * @returns 合并后的发布说明文本。
 */
function normalizeReleaseNotes(releaseNotes: UpdateInfo['releaseNotes']): string {
  if (typeof releaseNotes === 'string') return releaseNotes
  if (!Array.isArray(releaseNotes)) return ''
  return releaseNotes
    .map((item) => item.note)
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 将 electron-updater 更新信息转换为平台无关的更新信息。
 * @param info electron-updater 返回的更新信息。
 * @returns 供主进程和更新窗口使用的统一更新信息。
 */
function toPlatformUpdateInfo(info: UpdateInfo): PlatformUpdateInfo {
  const releaseNotes = normalizeReleaseNotes(info.releaseNotes)
  return {
    version: info.version,
    changelog: releaseNotes,
    releaseNotes
  }
}

export class ElectronUpdaterService {
  private state: ElectronUpdaterState = 'idle'
  private updateInfo: PlatformUpdateInfo | null = null
  private checkPromise: Promise<PlatformUpdateResult> | null = null
  private downloadPromise: Promise<PlatformUpdateActionResult> | null = null
  private downloadCancellationToken: CancellationToken | null = null
  private showWindowAfterDownload = true

  /**
   * 初始化标准更新器并绑定跨平台更新事件。
   * @param callbacks 更新生命周期回调。
   * @returns 创建的标准更新服务实例。
   */
  constructor(private readonly callbacks: PlatformUpdaterCallbacks) {
    // 禁止后台静默安装，由现有更新窗口统一控制下载和重启时机。
    autoUpdater.logger = log
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.autoRunAppAfterInstall = true
    autoUpdater.allowPrerelease = autoUpdater.currentVersion.prerelease.length > 0
    autoUpdater.disableDifferentialDownload = false

    // 未打包运行时读取 dev-app-update.yml，仅用于检查 GitHub Release。
    autoUpdater.forceDevUpdateConfig = !app.isPackaged

    // 将 electron-updater 状态映射到应用现有的更新状态机。
    autoUpdater.on('checking-for-update', () => {
      this.state = 'checking'
    })
    autoUpdater.on('update-available', (info) => {
      this.state = 'available'
      this.updateInfo = toPlatformUpdateInfo(info)
    })
    autoUpdater.on('update-not-available', () => {
      this.state = 'not-available'
      this.updateInfo = null
    })
    autoUpdater.on('download-progress', (info) => this.callbacks.onDownloadProgress(info))
    autoUpdater.on('update-downloaded', (info) => {
      this.state = 'downloaded'
      this.updateInfo = toPlatformUpdateInfo(info)
      this.callbacks.onDownloaded(this.updateInfo, this.showWindowAfterDownload)
    })
    autoUpdater.on('error', (error) => {
      this.state = 'error'
      this.callbacks.onDownloadFailed(error.message)
    })
  }

  /**
   * 检查标准更新源，并按需立即下载可用更新。
   * @param downloadWhenAvailable 发现更新后是否立即下载。
   * @returns 更新检查结果。
   */
  public async checkForUpdates(downloadWhenAvailable = false): Promise<PlatformUpdateResult> {
    if (this.checkPromise) return this.checkPromise

    // 合并并发检查，避免重复请求 GitHub Release 元数据。
    this.checkPromise = this.doCheckForUpdates(downloadWhenAvailable).finally(() => {
      this.checkPromise = null
    })
    return this.checkPromise
  }

  /**
   * 执行一次 electron-updater 检查并转换结果。
   * @param downloadWhenAvailable 发现更新后是否立即下载。
   * @returns 更新检查结果。
   */
  private async doCheckForUpdates(downloadWhenAvailable: boolean): Promise<PlatformUpdateResult> {
    try {
      this.state = 'checking'
      const result = await autoUpdater.checkForUpdates()
      if (!result || (this.state as ElectronUpdaterState) === 'not-available') {
        return {
          success: true,
          status: 'not-available',
          hasUpdate: false,
          currentVersion: autoUpdater.currentVersion.version,
          latestVersion: result?.updateInfo.version
        }
      }

      this.updateInfo = toPlatformUpdateInfo(result.updateInfo)
      if (downloadWhenAvailable) {
        const downloadResult = await this.downloadUpdate(true)
        if (!downloadResult.success) {
          return {
            success: false,
            status: 'error',
            hasUpdate: true,
            currentVersion: autoUpdater.currentVersion.version,
            latestVersion: this.updateInfo.version,
            updateInfo: this.updateInfo,
            error: downloadResult.error
          }
        }
      }

      return {
        success: true,
        status: this.state,
        hasUpdate: true,
        currentVersion: autoUpdater.currentVersion.version,
        latestVersion: this.updateInfo.version,
        updateInfo: this.updateInfo
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '检查更新失败'
      this.state = 'error'
      return {
        success: false,
        status: 'error',
        hasUpdate: false,
        currentVersion: autoUpdater.currentVersion.version,
        error: message
      }
    }
  }

  /**
   * 下载当前检查到的更新安装包，优先差分下载并在失败时回退到完整下载。
   * @param showWindowAfterDownload 下载完成后是否显示更新窗口。
   * @returns 下载操作结果。
   */
  public async downloadUpdate(
    showWindowAfterDownload: boolean
  ): Promise<PlatformUpdateActionResult> {
    if (this.state === 'downloaded') return { success: true }
    if (this.downloadPromise) return this.downloadPromise
    if (!this.updateInfo) return { success: false, error: '没有可下载的更新' }

    // 状态必须先切换，确保界面立即进入下载中状态。
    this.showWindowAfterDownload = showWindowAfterDownload
    this.state = 'downloading'
    this.callbacks.onDownloadStart({ version: this.updateInfo.version })
    const cancellationToken = new CancellationToken()
    this.downloadCancellationToken = cancellationToken
    this.downloadPromise = autoUpdater
      .downloadUpdate(cancellationToken)
      .then(() => {
        // 即使底层已进入无法中断的收尾阶段，也必须遵守先收到的取消请求。
        if (cancellationToken.cancelled) {
          this.state = 'available'
          this.callbacks.onDownloadCancelled()
          return { success: false, cancelled: true }
        }
        return { success: true }
      })
      .catch((error: unknown) => {
        // 用户取消属于可恢复状态，不应展示为下载失败或继续进入安装。
        if (cancellationToken.cancelled) {
          this.state = 'available'
          this.callbacks.onDownloadCancelled()
          return { success: false, cancelled: true }
        }
        const message = error instanceof Error ? error.message : '下载更新失败'
        this.state = 'error'
        this.callbacks.onDownloadFailed(message)
        return { success: false, error: message }
      })
      .finally(() => {
        // 只清理由本轮下载创建的令牌，避免覆盖后续重试。
        if (this.downloadCancellationToken === cancellationToken) {
          this.downloadCancellationToken = null
        }
        cancellationToken.dispose()
        this.downloadPromise = null
      })
    return this.downloadPromise
  }

  /**
   * 取消当前正在进行的更新下载，并保留可用更新供用户稍后重试。
   * @returns 下载请求完全结束后的取消结果。
   */
  public async cancelUpdate(): Promise<PlatformUpdateActionResult> {
    if (this.state !== 'downloading' || !this.downloadCancellationToken) {
      return { success: false, error: '当前没有正在下载的更新' }
    }

    // 等待本轮 Promise 完成清理，避免立即重试时复用已取消的下载。
    const activeDownload = this.downloadPromise
    this.downloadCancellationToken.cancel()
    await activeDownload
    return { success: true, cancelled: true }
  }

  /**
   * 根据可选服务端 feed 下载当前更新，并在完成后启动平台安装流程。
   * @param updateInfo 检查更新发现的目标版本及服务端 feed 地址。
   * @returns 下载和安装启动结果。
   */
  public async downloadAndInstall(
    updateInfo?: PlatformUpdateInfo
  ): Promise<PlatformUpdateActionResult> {
    if (updateInfo?.feedUrl) {
      // 服务端 feed 提供选中下载源的元数据和对应安装包地址。
      autoUpdater.setFeedURL({ provider: 'generic', url: updateInfo.feedUrl })
      const checkResult = await this.checkForUpdates(false)
      if (!checkResult.hasUpdate || checkResult.latestVersion !== updateInfo.version) {
        return { success: false, error: '更新元数据与当前版本不一致' }
      }
    }
    const downloadResult = await this.downloadUpdate(false)
    if (!downloadResult.success) return downloadResult
    return this.installDownloadedUpdate()
  }

  /**
   * 退出应用并安装已下载的完整更新包。
   * @returns 安装流程是否成功启动。
   */
  public installDownloadedUpdate(): PlatformUpdateActionResult {
    if (this.state !== 'downloaded') return { success: false, error: '更新尚未下载完成' }

    // NSIS 需要显式保留当前安装目录，macOS 则交给 Squirrel.Mac 替换应用包。
    this.state = 'installing'
    this.callbacks.onBeforeInstall()
    if (process.platform === 'win32') {
      ;(autoUpdater as NsisUpdater).installDirectory = path.dirname(process.execPath)
    }
    autoUpdater.quitAndInstall(true, true)
    return { success: true }
  }

  /**
   * 获取当前更新下载状态。
   * @returns 供更新窗口展示的下载状态。
   */
  public getDownloadStatus(): PlatformDownloadStatus {
    return {
      hasDownloaded: this.state === 'downloaded',
      version: this.updateInfo?.version,
      changelog: this.updateInfo?.changelog,
      status: this.state
    }
  }
}
