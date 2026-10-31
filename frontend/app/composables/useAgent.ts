import { toast } from 'vue-sonner'
import { api } from './useApi'

/** 运行选项：silent 关闭默认「完成」提示，由调用方自行提示 */
export interface AgentRunOptions {
  silent?: boolean
}

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: () => void, model?: string, configId?: number, options?: AgentRunOptions) {
    if (running.value) { toast.warning('操作执行中'); return null }
    running.value = true
    runningType.value = type
    try {
      const data = await api.post<any>(`/agent/${type}/chat`, {
        message: msg,
        drama_id: dramaId,
        episode_id: episodeId,
        model: model || undefined,
        config_id: configId || undefined,
      })
      if (!options?.silent) toast.success('完成')
      onDone?.()
      return data
    } catch (err: any) {
      toast.error(err.message)
      return null
    } finally {
      running.value = false
      runningType.value = null
    }
  }

  return { running, runningType, run }
}
