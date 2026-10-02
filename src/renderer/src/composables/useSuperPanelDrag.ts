import { computed, onBeforeUnmount, ref, type CSSProperties, type Ref } from 'vue'

// Adapted from JakeLaoyu/relaunch LaunchpadView.swift (MIT), ed849433.
// See docs/relaunch-drag.md and THIRD_PARTY_NOTICES/relaunch.txt.
interface DragItem {
  name: string
}

interface DragOptions<T extends DragItem> {
  items: Ref<T[]>
  folderItems: () => T[]
  key: (item: T) => string
  canMerge: (item: T) => boolean
  commit: (source: T, folder: boolean, outside: boolean, gap: number, target: string | null) => void
}

type Scope = 'root' | 'folder'

interface Geometry {
  grid: HTMLElement
  width: number
  height: number
  stepX: number
  stepY: number
  left: number
  top: number
}

interface DragBindings<T> {
  rootGrid: Ref<HTMLElement | null>
  folderGrid: Ref<HTMLElement | null>
  dragging: Ref<boolean>
  draggedOut: Ref<boolean>
  targetKey: Ref<string | null>
  begin: (event: PointerEvent, item: T, from: Scope) => void
  cancel: () => void
  guardClick: (event: MouseEvent) => void
  itemStyle: (item: T, index: number, from: Scope) => CSSProperties | undefined
}

/**
 * 将 relaunch 的浮动图标、尾随空槽和停留合并状态机适配为面板指针交互。
 * @param options 项目访问、身份识别及松手提交接口
 * @returns 模板绑定、起拖及取消接口
 */
export function useSuperPanelDrag<T extends DragItem>(options: DragOptions<T>): DragBindings<T> {
  const rootGrid = ref<HTMLElement | null>(null)
  const folderGrid = ref<HTMLElement | null>(null)
  const dragging = ref(false)
  const draggedOut = ref(false)
  const sourceKey = ref('')
  const targetKey = ref<string | null>(null)
  const scope = ref<Scope>('root')
  const gap = ref(0)
  let lastHoverSlot = 0
  let hoverKey: string | null = null
  let dwell: ReturnType<typeof setTimeout> | undefined
  let frame = 0
  let geometry: Geometry | null = null
  let source: T | null = null
  let pointerId: number | null = null
  let capture: HTMLElement | null = null
  let startX = 0
  let startY = 0
  let x = 0
  let y = 0
  let preview: HTMLElement | null = null
  let originElement: HTMLElement | null = null
  let suppressClick = false
  let clickTimer: ReturnType<typeof setTimeout> | undefined

  const activeScope = computed<Scope>(() => (draggedOut.value ? 'root' : scope.value))

  /**
   * 读取当前容器中的项目，拖出文件夹时使用顶层列表。
   * @returns 当前排列的项目
   */
  function items(): T[] {
    return activeScope.value === 'folder' ? options.folderItems() : options.items.value
  }

  /**
   * 停止合并倒计时并清除目标反馈。
   * @returns 无返回值
   */
  function cancelDwell(): void {
    clearTimeout(dwell)
    dwell = undefined
    targetKey.value = null
  }

  /**
   * 读取未变换的网格尺寸，命中检测不受让位动画影响。
   * @param grid 当前网格容器
   * @returns 固定槽位尺寸，空容器返回 null
   */
  function measure(grid: HTMLElement | null): Geometry | null {
    const cell = grid?.querySelector<HTMLElement>('.grid-item')
    if (!grid || !cell) return null
    const style = getComputedStyle(grid)
    return {
      grid,
      width: cell.offsetWidth,
      height: cell.offsetHeight,
      stepX: cell.getBoundingClientRect().width + parseFloat(style.columnGap),
      stepY: cell.offsetHeight + parseFloat(style.rowGap),
      left: parseFloat(style.paddingLeft),
      top: parseFloat(style.paddingTop)
    }
  }

  /**
   * 按槽位处理空槽、目标切换及 350ms 合并停留。
   * @returns 无返回值
   */
  function updateHover(): void {
    if (!geometry || !source) return
    const rect = geometry.grid.getBoundingClientRect()
    // 指针离开可见区域时取消合并，保留最后一个合法插入位置。
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      hoverKey = null
      cancelDwell()
      return
    }
    const flow = items().filter((item) => options.key(item) !== sourceKey.value)
    const col = Math.min(
      2,
      Math.max(0, Math.floor((x - rect.left - geometry.left) / geometry.stepX))
    )
    const row = Math.max(
      0,
      Math.floor((y - rect.top + geometry.grid.scrollTop - geometry.top) / geometry.stepY)
    )
    const slot = row * 3 + col
    if (slot === gap.value) {
      hoverKey = null
      cancelDwell()
      return
    }
    // 只有真实空白槽才视为末尾；最后一个已占用槽也允许合并。
    if (slot > flow.length) {
      gap.value = flow.length
      lastHoverSlot = flow.length
      hoverKey = null
      cancelDwell()
      return
    }
    const hovered = flow[slot < gap.value ? slot : slot - 1]
    if (!hovered || options.key(hovered) === hoverKey) return

    // 离开的项目填入尾随空槽，新目标保留在原处等待停留合并。
    gap.value = lastHoverSlot
    lastHoverSlot = slot
    hoverKey = options.key(hovered)
    cancelDwell()
    if (activeScope.value === 'root' && options.canMerge(source)) {
      const key = hoverKey
      dwell = setTimeout(() => {
        if (dragging.value && hoverKey === key) targetKey.value = key
      }, 350)
    }
  }

  /**
   * 在可滚动面板边缘持续滚动，重新计算内容坐标下的槽位。
   * @returns 无返回值
   */
  function tick(): void {
    if (!dragging.value || !geometry) return
    const { grid } = geometry
    const rect = grid.getBoundingClientRect()
    const old = grid.scrollTop
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      if (y < rect.top + 24) grid.scrollTop -= 5
      else if (y > rect.bottom - 24) grid.scrollTop += 5
    }
    if (grid.scrollTop !== old) updateHover()
    frame = requestAnimationFrame(tick)
  }

  /**
   * 跟随指针绘制浮动图标，并在跨越文件夹边界时接续顶层拖拽。
   * @param event 当前指针事件
   * @returns 无返回值
   */
  function move(event: PointerEvent): void {
    if (event.pointerId !== pointerId || !source) return
    x = event.clientX
    y = event.clientY
    if (!dragging.value) {
      if (Math.abs(x - startX) <= 6 && Math.abs(y - startY) <= 6) return
      geometry = measure(scope.value === 'root' ? rootGrid.value : folderGrid.value)
      if (!geometry || !originElement) return
      // 原项保持布局占位但隐藏；浮层不参与命中与 Vue 数据变更。
      preview = originElement.cloneNode(true) as HTMLElement
      preview.classList.remove('selected')
      preview.classList.add('drag-preview')
      preview.removeAttribute('data-item-key')
      Object.assign(preview.style, {
        position: 'fixed',
        width: `${geometry.width}px`,
        height: `${geometry.height}px`,
        margin: '0',
        pointerEvents: 'none',
        zIndex: '100',
        transition: 'none',
        transform: 'translate(-50%, -50%) scale(1.18)'
      })
      document.body.appendChild(preview)
      if (pointerId !== null) capture?.setPointerCapture(pointerId)
      dragging.value = true
      suppressClick = true
      frame = requestAnimationFrame(tick)
    }
    event.preventDefault()
    if (preview) {
      preview.style.left = `${x}px`
      preview.style.top = `${y}px`
    }
    if (scope.value === 'folder' && !draggedOut.value) {
      const panel = folderGrid.value?.closest('.folder-popup-panel')?.getBoundingClientRect()
      if (panel && (x < panel.left || x > panel.right || y < panel.top || y > panel.bottom)) {
        // 文件夹仍挂载以保留指针捕获；数据只在松手时迁移。
        draggedOut.value = true
        geometry = measure(rootGrid.value)
        gap.value = options.items.value.length
        lastHoverSlot = gap.value
        hoverKey = null
        cancelDwell()
      }
    }
    updateHover()
  }

  /**
   * 清理捕获、浮层、定时器和动画帧，取消不会修改项目数据。
   * @returns 无返回值
   */
  function cancel(): void {
    cancelDwell()
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('blur', cancel)
    window.removeEventListener('keydown', keydown, true)
    capture?.removeEventListener('lostpointercapture', cancel)
    if (pointerId !== null && capture?.hasPointerCapture(pointerId))
      capture.releasePointerCapture(pointerId)
    preview?.remove()
    preview = null
    capture = null
    pointerId = null
    source = null
    geometry = null
    originElement = null
    hoverKey = null
    dragging.value = false
    draggedOut.value = false
    sourceKey.value = ''
    // pointerup 后浏览器仍可能派发 click，留出同一事件循环的抑制窗口。
    clearTimeout(clickTimer)
    clickTimer = setTimeout(() => {
      suppressClick = false
    }, 0)
  }

  /**
   * 按最终预览一次性提交排序或合并，然后释放拖拽资源。
   * @param event 松手事件
   * @returns 无返回值
   */
  function end(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return
    try {
      if (dragging.value && source) {
        options.commit(
          source,
          scope.value === 'folder',
          draggedOut.value,
          gap.value,
          targetKey.value
        )
      }
    } finally {
      cancel()
    }
  }

  /**
   * 拖拽期间拦截键盘导航，Escape 只取消本次手势。
   * @param event 键盘事件
   * @returns 无返回值
   */
  function keydown(event: KeyboardEvent): void {
    if (!dragging.value) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.key === 'Escape') cancel()
  }

  /**
   * 记录按压身份并捕获指针，超过阈值前仍保留普通点击。
   * @param event 按压事件
   * @param item 被按压项目
   * @param from 项目所在容器
   * @returns 无返回值
   */
  function begin(event: PointerEvent, item: T, from: Scope): void {
    if (event.button !== 0 || !event.isPrimary || pointerId !== null) return
    clearTimeout(clickTimer)
    suppressClick = false
    source = item
    sourceKey.value = options.key(item)
    scope.value = from
    draggedOut.value = false
    startX = x = event.clientX
    startY = y = event.clientY
    gap.value = items().findIndex((entry) => options.key(entry) === sourceKey.value)
    lastHoverSlot = gap.value
    pointerId = event.pointerId
    originElement = event.currentTarget as HTMLElement
    capture = from === 'root' ? rootGrid.value : folderGrid.value
    capture?.addEventListener('lostpointercapture', cancel)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', keydown, true)
  }

  /**
   * 吞掉拖拽松手生成的点击，避免误启动指令或打开文件夹。
   * @param event 捕获阶段的点击事件
   * @returns 无返回值
   */
  function guardClick(event: MouseEvent): void {
    if (!suppressClick) return
    event.preventDefault()
    event.stopPropagation()
  }

  /**
   * 将稳定 DOM 项映射到固定槽位，让位动画不改变命中几何。
   * @param item 当前项目
   * @param index 项目在数据列表中的索引
   * @param from 网格所属容器
   * @returns 隐藏源项或平移到目标槽位的内联样式
   */
  function itemStyle(item: T, index: number, from: Scope): CSSProperties | undefined {
    if (!dragging.value || !geometry || from !== activeScope.value) return
    if (options.key(item) === sourceKey.value) return { visibility: 'hidden' }
    const flowIndex = items()
      .filter((entry) => options.key(entry) !== sourceKey.value)
      .findIndex((entry) => options.key(entry) === options.key(item))
    const slot = flowIndex >= gap.value ? flowIndex + 1 : flowIndex
    return {
      transform: `translate3d(${((slot % 3) - (index % 3)) * geometry.stepX}px, ${(Math.floor(slot / 3) - Math.floor(index / 3)) * geometry.stepY}px, 0)`,
      transitionProperty: 'transform',
      transitionDuration: '300ms',
      transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1.15)'
    }
  }

  onBeforeUnmount(() => {
    cancel()
    clearTimeout(clickTimer)
  })

  return {
    rootGrid,
    folderGrid,
    dragging,
    draggedOut,
    targetKey,
    begin,
    cancel,
    guardClick,
    itemStyle
  }
}
