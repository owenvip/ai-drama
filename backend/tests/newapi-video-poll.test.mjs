import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('volcengine video poll unwraps New API task envelope', () => {
  const adapter = read('src/services/adapters/volcengine-video.ts')

  // New API 返回 { code, message, data: { task_id, status, result_url, data: {...} } }
  assert.match(adapter, /function unwrapTaskPayload/)
  assert.match(adapter, /data\.status !== undefined/)
  assert.match(adapter, /data\.task_id !== undefined/)
  assert.match(adapter, /data\.result_url !== undefined/)

  // 轮询解析必须先解包，再读取 status / video_url
  assert.match(adapter, /const payload = unwrapTaskPayload\(result\)/)
  assert.match(adapter, /normalizeStatus\(payload\?\.status\)/)
  assert.match(adapter, /pickVideoUrl\(payload\)/)
  assert.match(adapter, /pickTaskId\(payload\)/)

  // New API 失败原因字段为 fail_reason
  assert.match(adapter, /payload\?\.fail_reason/)
})

test('New API wrapped SUCCESS status maps to completed and keeps signed video url', () => {
  const adapter = read('src/services/adapters/volcengine-video.ts')

  // SUCCESS / succeeded 等状态归一到 completed
  assert.match(adapter, /\['succeeded', 'success', 'completed', 'complete'\]/)
  // 解包后 Signed URL 位于 content.video_url
  assert.match(adapter, /result\?\.content\?\.video_url/)
  assert.match(adapter, /result\?\.data\?\.content\?\.video_url/)
})
