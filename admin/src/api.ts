export type TextSlot = {
  type: 'text'
  text: string
} | {
  type: 'image'
  assetId: string
  alt: string
}

export interface Content {
  invitation: {
    brand: TextSlot
    title: TextSlot
    greeting: TextSlot
    details: TextSlot
    backgroundImageId: string | null
    leftDoorImageId: string | null
    rightDoorImageId: string | null
    sealImageId: string | null
  }
  displayPages: { id: string; title: string; body: string; imageId: string | null }[]
  venue: { title: string; name: string; address: string; imageId: string | null }
  rsvp: { title: string; nameLabel: string; phoneLabel: string; partySizeLabel: string; submitLabel: string }
  bgmId: string | null
}

export interface Draft {
  revision: number
  content: Content
  firstPublishedAt: string | null
  expiresAt: string | null
}

export interface RsvpPage {
  totalPartySize: string
  filteredPartySize: string
  filteredRecords: string
  items: { id: string; name: string; phone: string; partySize: number; createdAt: string }[]
  nextCursor: string | null
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export async function api<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const multipart = body instanceof FormData
  let response: Response
  try {
    response = await fetch('/api/admin' + path, {
      method,
      headers: body && !multipart ? { 'Content-Type': 'application/json' } : undefined,
      body: multipart ? body : body && JSON.stringify(body),
      signal: AbortSignal.timeout(multipart ? 60000 : 15000),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('请求超时，请检查操作结果后重试。')
    throw new Error('无法连接服务器，请检查网络后重试。')
  }
  if (response.status === 204) return undefined as T

  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, payload?.error?.message || '操作失败，请稍后重试。')
  if (!payload) throw new Error('服务器返回格式异常，请刷新后重试。')
  return payload
}
