/**
 * 火山引擎（豆包 / Seedream）图片生成 Adapter
 * 端点: /api/v3/images/generations (注意 /api/v3 前缀)
 * 响应格式: { data: [{ url: "..." }] }（官方为同步返回）
 *
 * 兼容两种 Base URL：
 * 1. 火山方舟官方：https://ark.cn-beijing.volces.com（*.volces.com）
 *    协议：{ model, prompt, size: "1920x1080", image: [参考图], response_format, watermark }
 *    - size 必须为字符串（"1024x1024" / "2K"），不接受 width/height
 *    - 参考图放在 image（Seedream 支持单图或数组，数组即多图参考）
 * 2. 第三方兼容网关（如 api.chatfire.site/volcengine）
 *    协议：{ model, prompt, width, height }
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'

/** 判断是否为火山方舟官方端点 */
export function isOfficialArkUrl(baseUrl: string): boolean {
  const raw = (baseUrl || '').trim()
  if (!raw) return false
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return host === 'ark.cn-beijing.volces.com' || host.endsWith('.volces.com')
  } catch {
    return /volces\.com/i.test(raw)
  }
}

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

export class VolcEngineImageAdapter implements ImageProviderAdapter {
  provider = 'volcengine'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    // 火山引擎使用 seedream 模型
    const model = record.model || config.model || 'doubao-seedream-5-0-260128'
    const size = (record.size || '1920x1080').trim()
    const referenceImages = parseUrlArray(record.referenceImages)

    const url = joinProviderUrl(config.baseUrl, '/api/v3', '/images/generations')
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    }

    if (isOfficialArkUrl(config.baseUrl)) {
      const body: any = {
        model,
        prompt: record.prompt || '',
        // 官方只认字符串尺寸（如 1920x1080 / 2K）
        size,
        response_format: 'url',
        watermark: false,
      }
      if (referenceImages.length) {
        // 单图直接传字符串，多图传数组（多图参考用于保持角色/场景一致性）
        body.image = referenceImages.length === 1 ? referenceImages[0] : referenceImages
        body.sequential_image_generation = 'disabled'
      }
      return { url, method: 'POST', headers, body }
    }

    const body: any = {
      model,
      prompt: record.prompt,
    }

    // 兼容网关：尺寸参数
    if (record.size) {
      const [w, h] = record.size.split('x')
      if (w && h) {
        body.width = parseInt(w)
        body.height = parseInt(h)
      }
    }

    return { url, method: 'POST', headers, body }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // 官方错误体：{ error: { code, message } }
    if (result?.error) {
      const message = typeof result.error === 'string' ? result.error : result.error.message || result.error.code
      throw new Error(`VolcEngine image error: ${message || 'unknown error'}`)
    }
    // 兼容网关可能返回 task_id 进行轮询
    if (result.task_id || result.id) {
      return { isAsync: true, taskId: result.task_id || result.id }
    }
    // 同步返回（官方 Seedream）
    const imageUrl = result.data?.[0]?.url || result.url
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    // 只返回 base64 时交给 extractImageBase64
    if (result.data?.[0]?.b64_json) {
      return { isAsync: false }
    }
    throw new Error('No image URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/api/v3', `/images/generations/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = result.status
    if (status === 'succeeded') {
      return {
        status: 'completed',
        imageUrl: result.data?.[0]?.url || result.image_url,
      }
    }
    if (status === 'failed') {
      return { status: 'failed', error: result.error || 'Generation failed' }
    }
    return { status: status || 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.image_url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result?.data?.[0]?.b64_json
    if (typeof b64 === 'string' && b64.trim()) {
      return { data: b64.trim(), mimeType: 'image/png' }
    }
    return null
  }
}
