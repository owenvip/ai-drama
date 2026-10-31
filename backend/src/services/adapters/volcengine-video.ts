/**
 * 火山引擎 Seedance 视频生成 Adapter
 *
 * 支持两种兼容端点：
 * 1. 火山官方 Ark：POST /api/v3/contents/generations/tasks
 *    查询：GET /api/v3/contents/generations/tasks/:id
 * 2. OpenAI 兼容视频网关（如 TokenHub）：POST /v1/video/generations
 *    查询：GET /v1/video/generations/:id
 *    下载：GET /v1/videos/:id/content（需要 Authorization）
 *
 * 官方端点仅支持 Doubao Seedance 2.0+ 系列模型（如 doubao-seedance-2-0-260128、
 * doubao-seedance-2-0-fast-260128），生成模式只保留多模态参考:
 * - reference   多模态参考（≤9 reference_image + ≤3 reference_video + ≤3 reference_audio + 可选文本）
 *   有参考音频时至少包含 1 个参考图片或视频
 *
 * 网关端点使用 OpenAI 视频协议，参考素材放在 metadata.content 中，
 * 与网关内部转发到 Ark 的 content 数组结构一致。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

/** 仅支持 Seedance 2.0+ 系列（前缀匹配，兼容未来 2.0.x 变体） */
const SEEDANCE2_MODEL_PREFIX = 'doubao-seedance-2-0'
const DEFAULT_MODEL = 'doubao-seedance-2-0-fast-260128'

/** 多模态参考素材上限：图片 9、视频 3、音频 3 */
const REF_LIMITS = { images: 9, videos: 3, audios: 3 } as const

/** OpenAI 兼容视频网关路径 */
const GATEWAY_PREFIX = '/v1'
const GATEWAY_GENERATE_PATH = '/video/generations'
const GATEWAY_VIDEOS_PATH = '/videos'

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

/**
 * 判断 Base URL 是否应使用 OpenAI 兼容视频网关。
 *
 * 火山官方 Ark（*.volces.com）、以及通过 `/volcengine` 或 `/api/v3`
 * 暴露原生 Ark 接口的代理，继续走 `/api/v3/contents/generations/tasks`；
 * 其余自定义网关（例如 https://tokenhub-dne.geega.com）走
 * `/v1/video/generations`。
 */
export function isOpenAIVideoGateway(baseUrl: string): boolean {
  const raw = (baseUrl || '').trim()
  if (!raw) return false

  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    const path = url.pathname.replace(/\/+$/, '').toLowerCase()

    // TokenHub 等 OpenAI 兼容网关即使误填了 /api/v3 也应走视频网关。
    if (host.includes('tokenhub')) return true
    if (host === 'ark.cn-beijing.volces.com' || host.endsWith('.volces.com')) return false
    if (path.endsWith('/volcengine') || path.includes('/api/v3')) return false
    return true
  } catch {
    return !/volces\.com|volcengine|\/api\/v3/i.test(raw)
  }
}

/** 去掉网关 Base URL 末尾的 /api/v3 或 /v1，避免拼出重复前缀。 */
export function normalizeVideoGatewayBaseUrl(baseUrl: string): string {
  return (baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v3$/i, '')
    .replace(/\/v1$/i, '')
}

function normalizeStatus(status: unknown): VideoPollResponse['status'] {
  const value = String(status || '').toLowerCase()
  if (['succeeded', 'success', 'completed', 'complete'].includes(value)) return 'completed'
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired'].includes(value)) return 'failed'
  if (['queued', 'pending', 'submitted', 'not_start'].includes(value)) return 'pending'
  if (['running', 'in_progress', 'processing'].includes(value)) return 'processing'
  return 'processing'
}

function extractError(result: any): string {
  if (typeof result?.error === 'string') return result.error
  if (typeof result?.error?.message === 'string') return result.error.message
  return 'Video generation failed'
}

function pickVideoUrl(result: any): string | null {
  const candidates = [
    result?.video_url,
    result?.url,
    result?.content?.video_url,
    result?.content?.url,
    result?.data?.video_url,
    result?.data?.url,
    result?.data?.content?.video_url,
    result?.output?.video_url,
    result?.output?.url,
    result?.metadata?.video_url,
    result?.metadata?.url,
    result?.artifacts?.video?.url,
  ]
  const value = candidates.find((item) => typeof item === 'string' && item.trim())
  return value ? value.trim() : null
}

function pickTaskId(result: any): string | null {
  const candidates = [
    result?.id,
    result?.task_id,
    result?.data?.id,
    result?.data?.task_id,
    result?.output?.id,
    result?.output?.task_id,
  ]
  const value = candidates.find((item) => typeof item === 'string' && item.trim())
  return value ? value.trim() : null
}

export class VolcEngineVideoAdapter implements VideoProviderAdapter {
  provider = 'volcengine'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    const gateway = isOpenAIVideoGateway(config.baseUrl)

    if (!gateway && !model.startsWith(SEEDANCE2_MODEL_PREFIX)) {
      throw new Error(`仅支持 Seedance 2.0 系列模型（${SEEDANCE2_MODEL_PREFIX}-*），当前: ${model}`)
    }

    const prompt = (record.prompt || '').trim()
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)

    if (refImages.length > REF_LIMITS.images || refVideos.length > REF_LIMITS.videos || refAudios.length > REF_LIMITS.audios) {
      throw new Error(`参考素材超限：图片≤${REF_LIMITS.images}、视频≤${REF_LIMITS.videos}、音频≤${REF_LIMITS.audios}`)
    }
    if (refAudios.length > 0 && refImages.length + refVideos.length === 0) {
      throw new Error('参考音频需要至少 1 个参考图片或视频')
    }
    if (!prompt && !refImages.length && !refVideos.length && !refAudios.length) {
      throw new Error('多模态参考模式需要至少一个参考素材或 prompt')
    }

    const resolution = record.resolution === '480p' ? '480p' : '720p'
    const ratio = record.aspectRatio || '16:9'
    const generateAudio = record.generateAudio !== 0 && record.generateAudio !== false

    if (gateway) {
      return {
        url: joinProviderUrl(normalizeVideoGatewayBaseUrl(config.baseUrl), GATEWAY_PREFIX, GATEWAY_GENERATE_PATH),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: this.buildGatewayBody({
          model,
          prompt,
          refImages,
          refVideos,
          refAudios,
          generateAudio,
          duration: record.duration,
          ratio,
          resolution,
        }),
      }
    }

    const content: any[] = []
    if (prompt) content.push({ type: 'text', text: prompt })
    for (const url of refImages) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of refVideos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of refAudios) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
    }

    const body: any = {
      model,
      content,
      generate_audio: record.generateAudio !== 0 && record.generateAudio !== false,
      ratio: record.aspectRatio || 'adaptive',
      duration: this.normalizeDuration(record.duration),
      resolution: record.resolution === '480p' ? '480p' : '720p',
      watermark: false,
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/api/v3', '/contents/generations/tasks'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  private buildGatewayBody(input: {
    model: string
    prompt: string
    refImages: string[]
    refVideos: string[]
    refAudios: string[]
    generateAudio: boolean
    duration?: number | null
    ratio: string
    resolution: string
  }) {
    // 网关会把 metadata 合并进 Ark 请求体；参考素材必须以 content 项传入。
    const content: any[] = []
    for (const url of input.refImages) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of input.refVideos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of input.refAudios) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
    }

    const metadata: Record<string, any> = {
      resolution: input.resolution,
      ratio: input.ratio,
      generate_audio: input.generateAudio,
      watermark: false,
    }
    if (content.length) metadata.content = content

    return {
      model: input.model,
      prompt: input.prompt,
      seconds: String(this.normalizeDuration(input.duration)),
      metadata,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = pickTaskId(result)
    if (taskId) {
      return { isAsync: true, taskId }
    }
    // 同步返回
    const videoUrl = pickVideoUrl(result)
    if (videoUrl) {
      return { isAsync: false, videoUrl }
    }
    throw new Error('No task_id or video_url in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const gateway = isOpenAIVideoGateway(config.baseUrl)
    return {
      url: gateway
        ? joinProviderUrl(normalizeVideoGatewayBaseUrl(config.baseUrl), GATEWAY_PREFIX, `${GATEWAY_GENERATE_PATH}/${taskId}`)
        : joinProviderUrl(config.baseUrl, '/api/v3', `/contents/generations/tasks/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any, config?: AIConfig, taskId?: string): VideoPollResponse {
    const status = normalizeStatus(result?.status)
    if (status === 'completed') {
      const videoUrl = pickVideoUrl(result)
      if (videoUrl) {
        return {
          status: 'completed',
          videoUrl,
        }
      }

      // OpenAI 兼容网关的查询响应不包含视频地址，需从 /v1/videos/:id/content 下载。
      if (config && isOpenAIVideoGateway(config.baseUrl)) {
        const id = taskId || pickTaskId(result)
        if (id) {
          return {
            status: 'completed',
            videoUrl: joinProviderUrl(normalizeVideoGatewayBaseUrl(config.baseUrl), GATEWAY_PREFIX, `${GATEWAY_VIDEOS_PATH}/${id}/content`),
            videoHeaders: {
              'Authorization': `Bearer ${config.apiKey}`,
            },
          }
        }
      }

      return { status: 'completed' }
    }
    if (status === 'failed') {
      return { status: 'failed', error: extractError(result) }
    }
    return { status }
  }

  extractVideoUrl(result: any): string | null {
    return pickVideoUrl(result)
  }

  private normalizeDuration(duration?: number | null): number {
    const parsed = Math.round(Number(duration || 5))
    if (!Number.isFinite(parsed)) return 5
    // Seedance 2.0 支持 4-15 秒
    return Math.min(15, Math.max(4, parsed))
  }
}
