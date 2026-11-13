export type InvitationSlot = { type: 'text'; text: string } | { type: 'image'; imageUrl: string; alt: string }

export interface Invitation {
  firstPublishedAt: string
  expiresAt: string
  content: {
    invitation: Record<'brand' | 'title' | 'greeting' | 'details', InvitationSlot> & {
      backgroundImageUrl: string | null
      leftDoorImageUrl: string | null
      rightDoorImageUrl: string | null
      sealImageUrl: string | null
    }
    displayPages: { id: string; title: string; body: string; imageUrl: string | null }[]
    venue: { title: string; name: string; address: string; imageUrl: string | null }
    rsvp: { title: string; nameLabel: string; phoneLabel: string; partySizeLabel: string; submitLabel: string }
    bgmUrl: string | null
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export async function invitationRequest<T>(path = '', options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/public/invitation' + path, {
    ...options, cache: 'no-store', signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json()
  if (!response.ok) throw new ApiError(response.status, payload.error?.message || '暂时无法完成请求，请重试')
  return payload
}

export function submissionKey() {
  // getRandomValues also works on the phone's local-network HTTP preview.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
