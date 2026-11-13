<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ApiError, invitationRequest, submissionKey, type Invitation } from './invitation'

const invitation = ref<Invitation | null>(null)
const content = computed(() => invitation.value?.content)
const venue = computed(() => content.value!.venue)
const slots = ['brand', 'title', 'greeting', 'details'] as const
const opened = ref(false)
const page = ref('invitation')
const changingPage = ref(false)
const stage = ref<HTMLElement | null>(null)
const rsvpWidth = ref<number>()
const rsvpConfirmation = ref<HTMLDialogElement | null>(null)
const venueImageError = ref(false)
const music = ref<HTMLAudioElement | null>(null)
const musicPlaying = ref(false)
const loading = ref(true)
const loadError = ref('')
const closed = ref(false)
const submitting = ref(false)
const submitError = ref('')
const guest = ref({ name: '', phone: '', partySize: '' })
const pages = computed(() => ['invitation', ...(content.value?.displayPages.map(item => item.id) || []), 'map', 'rsvp'])
const displayPage = computed(() => content.value?.displayPages.find(item => item.id === page.value))
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let pendingSubmission = { body: '', key: '' }

function closeInvitation(message: string) {
  clearTimeout(expiryTimer)
  music.value?.pause()
  rsvpConfirmation.value?.close()
  invitation.value = null
  closed.value = true
  loadError.value = message
}

function checkExpiry() {
  clearTimeout(expiryTimer)
  if (!invitation.value) return
  const remaining = Date.parse(invitation.value.expiresAt) - Date.now()
  if (remaining <= 0) closeInvitation('邀请函已到期')
  else expiryTimer = setTimeout(checkExpiry, Math.min(remaining, 60000))
}

async function loadInvitation() {
  loading.value = true
  loadError.value = ''
  try {
    const result = await invitationRequest<Invitation>()
    if (content.value?.venue.imageUrl !== result.content.venue.imageUrl) venueImageError.value = false
    invitation.value = result
    closed.value = false
    if (!pages.value.includes(page.value)) page.value = 'invitation'
    checkExpiry()
  } catch (error) {
    closeInvitation(error instanceof ApiError ? error.message : '暂时无法加载邀请函，请重试')
    closed.value = error instanceof ApiError && (error.status === 404 || error.status === 410)
  } finally { loading.value = false }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible' && !loading.value) void loadInvitation()
}

async function toggleMusic() {
  if (!music.value) return
  if (!music.value.paused) music.value.pause()
  else {
    try { await music.value.play() } catch { musicPlaying.value = false }
  }
}

function openInvitation() {
  opened.value = true
  if (content.value?.bgmUrl) void toggleMusic()
}

function nextPage() {
  if (changingPage.value) return
  const next = pages.value[pages.value.indexOf(page.value) + 1]
  if (!next) return
  changingPage.value = true
  if (next === 'rsvp') rsvpWidth.value = stage.value?.getBoundingClientRect().width
  page.value = next
}

function finishPageChange(element: Element) {
  changingPage.value = false
  if (element instanceof HTMLElement) element.focus()
}

async function submitRsvp() {
  if (submitting.value || !invitation.value) return
  checkExpiry()
  if (!invitation.value) return
  const partySize = Number(guest.value.partySize)
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 4294967295) {
    submitError.value = '请填写含本人的有效正整数人数'
    return
  }
  const body = JSON.stringify({ name: guest.value.name.trim(), phone: guest.value.phone.trim(), partySize })
  if (pendingSubmission.body !== body) pendingSubmission = { body, key: submissionKey() }
  submitting.value = true
  submitError.value = ''
  try {
    const result = await invitationRequest<{ id: string }>('/rsvps', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pendingSubmission.key }, body,
    })
    if (!result.id) throw new Error('Missing receipt')
    checkExpiry()
    await nextTick()
    if (invitation.value) rsvpConfirmation.value?.showModal()
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 410)) closeInvitation(error.message)
    else submitError.value = error instanceof ApiError ? error.message : '保存结果尚未确认，请重试'
  } finally { submitting.value = false }
}

onMounted(() => {
  void loadInvitation()
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onUnmounted(() => {
  clearTimeout(expiryTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div v-if="!content" class="invitation-status" role="status">
    <p>{{ loading ? '正在加载邀请函…' : loadError }}</p>
    <button v-if="!loading && !closed" class="submit-rsvp" @click="loadInvitation">重试</button>
  </div>
  <main
    v-else
    ref="stage"
    class="stage"
    :class="{ opened }"
    :style="rsvpWidth ? { width: `min(100vw, ${rsvpWidth}px)` } : undefined"
  >
    <img class="invitation-background" v-if="content.invitation.backgroundImageUrl" :src="content.invitation.backgroundImageUrl" alt="" fetchpriority="high" />
    <Transition name="page" mode="out-in" @after-enter="finishPageChange">
      <section v-if="page === 'invitation'" class="invitation" aria-label="活动邀请函" :aria-hidden="!opened">
        <template v-for="slot in slots" :key="slot">
          <img v-if="content.invitation[slot].type === 'image'" class="invitation-line" :class="slot"
            :src="(content.invitation[slot] as { imageUrl: string }).imageUrl"
            :alt="(content.invitation[slot] as { alt: string }).alt" />
          <p v-else class="invitation-line invitation-text" :class="slot">{{ (content.invitation[slot] as { text: string }).text }}</p>
        </template>
      </section>
      <section
        v-else
        :key="page"
        class="content-page"
        aria-labelledby="page-heading"
        tabindex="-1"
      >
        <div v-if="page === 'map'" class="venue">
          <h1 id="page-heading">{{ venue.title }}</h1>
          <div class="venue-map">
            <div class="venue-map-frame">
              <div class="venue-map-window">
                <img v-if="venue.imageUrl && !venueImageError" :key="venue.imageUrl" :src="venue.imageUrl" alt="活动地点图片" @error="venueImageError = true" />
                <span v-else>地点图片待添加</span>
              </div>
            </div>
          </div>
          <h2 class="venue-name">{{ venue.name }}</h2>
          <p class="venue-address">{{ venue.address }}</p>
        </div>
        <form v-else-if="page === 'rsvp'" class="rsvp" @submit.prevent="submitRsvp">
          <h1 id="page-heading">{{ content.rsvp.title }}</h1>
          <div class="rsvp-divider" aria-hidden="true"></div>
          <label>{{ content.rsvp.nameLabel }}
            <input v-model="guest.name" :disabled="submitting" name="name" type="text" autocomplete="name" maxlength="100" required />
          </label>
          <label>{{ content.rsvp.phoneLabel }}
            <input v-model="guest.phone" :disabled="submitting" name="phone" type="tel" autocomplete="tel" inputmode="tel" pattern="[+]?[0-9][0-9 \(\)\-]{5,19}" required />
          </label>
          <label>{{ content.rsvp.partySizeLabel }}
            <input v-model="guest.partySize" :disabled="submitting" name="partySize" type="text" inputmode="numeric" pattern="[1-9][0-9]*" required />
          </label>
          <div class="rsvp-flower" aria-hidden="true">✿</div>
          <p v-if="submitError" class="submit-error" role="alert">{{ submitError }}</p>
          <button class="submit-rsvp" type="submit" :disabled="submitting">{{ submitting ? '保存中…' : content.rsvp.submitLabel }}</button>
        </form>
        <div v-else-if="displayPage" class="display-page">
          <h1 id="page-heading">{{ displayPage.title }}</h1>
          <img v-if="displayPage.imageUrl" :src="displayPage.imageUrl" :alt="displayPage.title" />
          <p v-if="displayPage.body">{{ displayPage.body }}</p>
        </div>
      </section>
    </Transition>
    <button v-if="opened && page !== 'rsvp'" class="next-page" type="button" :disabled="changingPage" @click="nextPage">下一页</button>
    <div class="doors" aria-hidden="true">
      <div class="door left" :class="{ 'door-placeholder': !content.invitation.leftDoorImageUrl }">
        <img class="door-face" v-if="content.invitation.leftDoorImageUrl" :src="content.invitation.leftDoorImageUrl" alt="" />
        <span class="door-edge"><span class="seal-mount"></span></span>
        <div class="wax">
          <span v-for="layer in 4" :key="layer" class="wax-rim" :style="{ '--layer': layer }"></span>
          <img v-if="content.invitation.sealImageUrl" :src="content.invitation.sealImageUrl" alt="" />
        </div>
      </div>
      <div class="door right" :class="{ 'door-placeholder': !content.invitation.rightDoorImageUrl }">
        <img class="door-face" v-if="content.invitation.rightDoorImageUrl" :src="content.invitation.rightDoorImageUrl" alt="" />
        <span class="door-edge"><span class="lock-slot"></span></span>
      </div>
    </div>
    <button
      class="open-cover"
      type="button"
      aria-label="打开邀请函"
      :disabled="opened"
      @click="openInvitation"
    >
      <span v-if="!opened && !content.invitation.leftDoorImageUrl && !content.invitation.rightDoorImageUrl" class="open-hint">点击开启邀请函</span>
    </button>
    <template v-if="content.bgmUrl">
      <audio ref="music" :src="content.bgmUrl" loop @play="musicPlaying = true" @pause="musicPlaying = false" @ended="musicPlaying = false" />
      <button v-if="opened" class="music-toggle" :aria-pressed="musicPlaying" @click="toggleMusic">{{ musicPlaying ? '暂停音乐' : '播放音乐' }}</button>
    </template>
    <dialog ref="rsvpConfirmation" class="rsvp-confirmation" aria-labelledby="rsvp-confirmation-heading">
      <h2 id="rsvp-confirmation-heading">期待您的莅临</h2>
      <form method="dialog">
        <button class="submit-rsvp">确定</button>
      </form>
    </dialog>
  </main>
</template>

<style>
.invitation-status { padding: 24px; text-align: center; }
.display-page { width: 75%; max-height: 70%; overflow-y: auto; text-align: center; }
.display-page img { width: 100%; max-height: 45vh; object-fit: contain; margin-top: 18px; }
.display-page p { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; }
.submit-error { color: #ffe2b3; font-size: 12px; margin: 0; }
button:disabled { cursor: default; }
.music-toggle { position: absolute; top: 14px; right: 14px; border: 1px solid #c3ac73; background: #394538; color: #f1dfa7; border-radius: 20px; padding: 8px 12px; }

:root {
  background: #31382e;
  color: #f5e5bd;
  font-family: "Songti SC", SimSun, serif;
}

body {
  margin: 0;
}

#app {
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
}

.stage {
  --opening-time: 2800ms;
  --right-door-delay: 150ms;
  --letter-entry: calc(var(--opening-time) + var(--right-door-delay) + 160ms);
  position: relative;
  width: min(100vw, 480px, 46vh);
  width: min(100vw, 480px, 46dvh);
  aspect-ratio: 1206 / 2622;
  overflow: hidden;
  overflow: clip;
  isolation: isolate;
  background: #535c4d;
}

.invitation,
.content-page,
.invitation-line,
.invitation-background,
.doors {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.invitation-line,
.invitation-background {
  object-fit: fill;
}

.invitation-background {
  filter: brightness(.35);
  transition: filter 2050ms ease-out 400ms;
}

.invitation-line {
  opacity: 0;
  filter: blur(4px);
  transform: translateX(-12%);
  transition: opacity 650ms ease, filter 700ms ease, transform 800ms cubic-bezier(.2, .65, .25, 1);
  transition-delay: calc(var(--letter-entry) + var(--stagger, 0ms));
}

.title,
.details { transform: translateX(12%); }
.title { --stagger: 180ms; }
.greeting { --stagger: 390ms; }
.details { --stagger: 600ms; }

.doors {
  pointer-events: none;
  display: flex;
  perspective: 780px;
}

.door {
  position: relative;
  width: 50%;
  height: 100%;
  transform-style: preserve-3d;
  transition: transform var(--opening-time) cubic-bezier(.62, .03, .34, 1);
}

.door-face {
  display: block;
  width: 100%;
  height: 100%;
  backface-visibility: hidden;
}

.door-placeholder {
  box-sizing: border-box;
  border: 1px solid #b9a271;
  background: linear-gradient(135deg, #465241, #2d3b31);
}

.door-placeholder::before {
  content: "";
  position: absolute;
  inset: 5% 8%;
  border: 1px solid #b9a27166;
}

.open-hint {
  padding: 14px 20px;
  border: 1px solid #b9a271;
  border-radius: 6px;
  background: #344536;
  color: #f5e5bd;
  font: 16px/1.5 "Songti SC", SimSun, serif;
  letter-spacing: .15em;
}

.door-edge {
  position: absolute;
  top: 0;
  bottom: 0;
  width: clamp(12px, 4.5vw, 21px);
  background: linear-gradient(to right, #292e25, #545a46 18%, #77775d 47%, #434737 85%, #252820);
  box-shadow: inset 0 0 7px #161910ad, 0 0 10px #12160e6b;
  backface-visibility: hidden;
}

.left {
  transform-origin: left center;
  z-index: 1;
}

.left .door-edge {
  left: 100%;
  transform-origin: left center;
  transform: rotateY(90deg);
}

.right {
  transform-origin: right center;
  transition-delay: var(--right-door-delay);
}

.right .door-edge {
  right: 100%;
  transform-origin: right center;
  transform: rotateY(-90deg);
}

.seal-mount,
.lock-slot {
  position: absolute;
  top: 47.16%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.seal-mount {
  width: 75%;
  height: 12%;
  border-radius: 35%;
  background: linear-gradient(to right, #261e13, #9b8250 35%, #4c3e26 68%, #211c13);
  box-shadow: 0 1px 5px #15150e;
}

.lock-slot {
  width: 38%;
  height: 8%;
  border-radius: 4px;
  background: #24231a;
  box-shadow: inset 2px 0 3px #0d0d09, 1px 0 #b2a179;
}

.wax {
  position: absolute;
  left: 64.84%;
  top: 39.25%;
  width: 68.5%;
  height: 15.83%;
  --rim-step: clamp(1px, .48vw, 2px);
  transform-style: preserve-3d;
}

.wax-rim {
  position: absolute;
  inset: 4%;
  border-radius: 50%;
  background: linear-gradient(165deg, #a78948, #786031 36%, #45341d 76%, #6a522c);
  transform: translateZ(calc(var(--layer) * var(--rim-step)));
  backface-visibility: hidden;
}

.wax img {
  display: block;
  width: 100%;
  height: 100%;
  transform: translateZ(calc(5 * var(--rim-step)));
  filter: drop-shadow(1px 2px 2px #241b11b0);
  backface-visibility: hidden;
}

.open-cover {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.open-cover:focus-visible {
  outline: 2px solid #f5e5bd;
  outline-offset: -6px;
}

.open-cover:disabled { pointer-events: none; }
.opened .left { transform: rotateY(-106deg); }
.opened .right { transform: rotateY(106deg); }
.opened .invitation-background { filter: brightness(1); }
.opened .invitation-line {
  opacity: 1;
  filter: blur(0);
  transform: translateX(0);
}

.content-page {
  display: grid;
  place-items: center;
}

.content-page h1 {
  margin: 0;
  color: #e8d395;
  font-size: clamp(20px, 5vw, 27px);
  font-weight: normal;
  letter-spacing: .18em;
}

.venue {
  width: 68%;
  text-align: center;
  container-type: inline-size;
}

.venue h1 {
  color: #f1d997;
  font-family: "Songti SC", "Noto Serif CJK SC", SimSun, serif;
  font-size: clamp(18px, 8.5cqw, 25px);
  font-weight: 600;
  letter-spacing: .22em;
  text-indent: .22em;
  text-shadow: 0 1px #554429, 0 2px 4px #262c23;
}

.venue-map {
  position: relative;
  width: 83%;
  margin: clamp(9px, 5cqw, 15px) auto 0;
  filter: drop-shadow(0 4px 6px #17201990);
}

.venue-map-frame {
  --frame-outline: polygon(50% 0, 58% 1%, 67% 5%, 73% 10%, 88% 17%, 96% 23%, 99% 28%, 100% 34%, 100% 81%, 99% 87%, 95% 91%, 87% 96%, 78% 100%, 22% 100%, 13% 96%, 5% 91%, 1% 87%, 0 81%, 0 34%, 1% 28%, 4% 23%, 12% 17%, 27% 10%, 33% 5%, 42% 1%);
  position: relative;
  aspect-ratio: 1 / 1.19;
  padding: 8px;
  clip-path: var(--frame-outline);
  background: linear-gradient(145deg, #f1d997, #977b45 48%, #d4b775 80%, #977b45);
}

.venue-map-frame::before,
.venue-map-frame::after {
  content: "";
  position: absolute;
  clip-path: var(--frame-outline);
}

.venue-map-frame::before {
  inset: 2px;
  background: #343c30;
}

.venue-map-frame::after {
  inset: 5px;
  background: linear-gradient(155deg, #977b45, #d4b775 56%, #977b45);
}

.venue-map-window {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  height: 100%;
  overflow: hidden;
  clip-path: var(--frame-outline);
  background: #414a3b;
  color: #eddbad;
  font-size: 13px;
}

.venue-map-window img {
  position: absolute;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.venue-name {
  --plaque-outline: polygon(13% 0, 87% 0, 91% 13%, 97% 25%, 100% 50%, 97% 75%, 91% 87%, 87% 100%, 13% 100%, 9% 87%, 3% 75%, 0 50%, 3% 25%, 9% 13%);
  position: relative;
  isolation: isolate;
  width: fit-content;
  max-width: 92%;
  margin: 12px auto 0;
  padding: 9px 19px;
  clip-path: var(--plaque-outline);
  background: #c6ad76;
  color: #f0dba5;
  font: 500 clamp(12px, 6cqw, 17px)/1.35 "Songti SC", SimSun, "Noto Serif CJK SC", serif;
}

.venue-map + .venue-name { margin-top: -7px; }

.venue-name::before,
.venue-name::after {
  content: "";
  position: absolute;
  clip-path: var(--plaque-outline);
}

.venue-name::before {
  inset: 1px;
  z-index: -2;
  background: #4b5545;
}

.venue-name::after {
  inset: 4px;
  z-index: -1;
  border-block: 1px solid #a58f63;
  background: radial-gradient(circle at 5% 50%, #c6ad76 1px, transparent 2px),
    radial-gradient(circle at 95% 50%, #c6ad76 1px, transparent 2px), #545e4b;
}

.venue-address {
  margin: 8px auto 0;
  color: #e9d9b1;
  font: 400 clamp(10px, 4.4cqw, 12px)/1.65 "Songti SC", SimSun, "Noto Serif CJK SC", serif;
}

.rsvp {
  display: grid;
  gap: clamp(10px, 1.65vh, 15px);
  width: 61%;
  text-align: center;
}

.rsvp h1 {
  margin: 0;
  justify-self: center;
  white-space: nowrap;
  color: #e7d2a3;
  font-family: "Songti SC", "Noto Serif CJK SC", SimSun, serif;
  font-weight: 400;
  font-size: clamp(20px, 6vw, 28px);
  letter-spacing: .2em;
  text-indent: .2em;
  text-shadow: 0 1px 1px #18231c;
}

.rsvp-divider {
  width: 40%;
  height: 1px;
  margin: 0 auto;
  background: linear-gradient(90deg, transparent, #cbb07890, transparent);
}

.rsvp label {
  display: grid;
  justify-items: center;
  gap: 2px;
  white-space: nowrap;
  color: #e2cfa5;
  font-size: clamp(12px, 3.5vw, 15px);
  letter-spacing: .12em;
}

.rsvp input {
  box-sizing: border-box;
  width: 88%;
  min-height: 36px;
  padding: 3px 6px;
  border: 0;
  border-bottom: 1px solid #d7bb8090;
  border-radius: 0;
  background: transparent;
  color: #fff0c4;
  font-family: inherit;
  font-size: 16px;
  text-align: center;
}

.rsvp input:focus {
  outline: none;
  border-color: #d7bb80a8;
}

.rsvp input:-webkit-autofill {
  background-clip: text;
  -webkit-text-fill-color: #fff0c4;
  caret-color: #fff0c4;
}

.submit-rsvp:focus-visible {
  outline: 2px solid #f3dfa1;
  outline-offset: 2px;
}

.rsvp-flower {
  justify-self: center;
  display: flex;
  align-items: center;
  gap: 9px;
  color: #cbb078;
  font-size: 16px;
  line-height: 1;
}

.rsvp-flower::before,
.rsvp-flower::after {
  content: "";
  width: 24px;
  height: 1px;
  background: linear-gradient(90deg, transparent, #cbb07888, transparent);
}

.submit-rsvp {
  justify-self: center;
  min-width: 62%;
  min-height: 44px;
  margin-top: 5px;
  border: 1px solid #d6be89;
  border-radius: 999px;
  background: #d9c394;
  color: #25372c;
  box-shadow: 0 2px 4px #18201965;
  font: inherit;
  letter-spacing: .2em;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.rsvp-confirmation {
  box-sizing: border-box;
  width: min(80vw, 320px);
  padding: 28px 20px 22px;
  border: 1px solid #c3ac73;
  border-radius: 12px;
  background: #394538;
  color: #f1dfa7;
  text-align: center;
}

.rsvp-confirmation::backdrop { background: #182219a6; }

.rsvp-confirmation h2 {
  margin: 0 0 20px;
  color: #e7d2a3;
  font: 400 clamp(20px, 6vw, 26px)/1.4 "Songti SC", "Noto Serif CJK SC", SimSun, serif;
  letter-spacing: .14em;
  text-indent: .14em;
  white-space: nowrap;
  text-shadow: 0 1px 1px #18231c;
}

.content-page:focus { outline: none; }

.page-enter-active {
  animation: content-enter 650ms cubic-bezier(.2, .65, .25, 1) both;
}

.page-enter-active:has(.venue) {
  animation: none;
  transition: opacity 1080ms;
}

.page-enter-active .venue > * {
  animation: venue-reveal 620ms cubic-bezier(.2, .65, .25, 1) both;
}

.page-enter-active .venue h1 { animation-delay: 90ms; }
.page-enter-active .venue-name { animation-delay: 260ms; }
.page-enter-active .venue-address { animation-delay: 460ms; }

.page-enter-active:has(.rsvp) {
  animation: none;
  transition: opacity 1480ms;
}

.page-enter-active .rsvp > * {
  animation: venue-reveal 600ms cubic-bezier(.2, .65, .25, 1) both;
}

.page-enter-active .rsvp .rsvp-divider { animation-delay: 100ms; }
.page-enter-active .rsvp label:nth-of-type(1) { animation-delay: 220ms; }
.page-enter-active .rsvp label:nth-of-type(2) { animation-delay: 400ms; }
.page-enter-active .rsvp label:nth-of-type(3) { animation-delay: 580ms; }
.page-enter-active .rsvp .rsvp-flower { animation-delay: 720ms; }
.page-enter-active .rsvp .submit-rsvp { animation-delay: 880ms; }

@keyframes venue-reveal {
  from { opacity: 0; transform: translateY(12px); filter: blur(3px); }
  to { opacity: 1; transform: translateY(0); filter: blur(0); }
}

@keyframes content-enter {
  from { transform: translateY(7%); opacity: 0; filter: blur(4px); }
  to { transform: translateY(0); opacity: 1; filter: blur(0); }
}

.page-leave-active {
  animation: invitation-exit 520ms cubic-bezier(.44, 0, .72, .65) both;
  pointer-events: none;
}

@keyframes invitation-exit {
  0% { transform: translateY(0); opacity: 1; }
  35% { opacity: 1; }
  100% { transform: translateY(-30%); opacity: 0; }
}

.next-page {
  position: absolute;
  left: 50%;
  top: 86%;
  transform: translate(-50%, -50%);
  width: 32%;
  min-height: 44px;
  border: 0;
  background: none;
  color: #f3dfa1;
  font: inherit;
  font-size: clamp(11px, 3vw, 13px);
  letter-spacing: .12em;
  cursor: pointer;
  isolation: isolate;
  -webkit-tap-highlight-color: transparent;
  animation: next-page-appear 400ms ease both;
  animation-delay: calc(var(--letter-entry) + 900ms);
}

.next-page:disabled { cursor: default; }

.next-page::before {
  content: "";
  position: absolute;
  inset: 8px 0;
  z-index: -1;
  border: 1px solid #b7a36b;
  border-radius: 999px;
  background: #414a3b;
  box-shadow: 0 2px 5px #252c2359;
}

@keyframes next-page-appear {
  from { opacity: 0; visibility: hidden; }
  to { opacity: 1; visibility: visible; }
}

.invitation-text {
  box-sizing: border-box;
  inset: auto 12%;
  width: 76%;
  height: auto;
  margin: 0;
  text-align: center;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
  font-size: clamp(12px, 3.8vw, 20px);
  max-height: 22%;
  overflow-y: auto;
}
.invitation-text.brand { top: 19%; }
.invitation-text.title { top: 32%; font-size: clamp(22px, 6vw, 32px); }
.invitation-text.greeting { top: 47%; }
.invitation-text.details { top: 66%; }

@media (prefers-reduced-motion: reduce) {
  .page-enter-active:has(.rsvp) { transition: none; }
  .stage * { transition: none; }
  .page-enter-active,
  .page-enter-active .venue > *,
  .page-enter-active .rsvp > *,
  .page-leave-active,
  .next-page { animation: none; }
}
</style>










