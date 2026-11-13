<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import AssetField from './AssetField.vue'
import { ApiError, api, type Content, type Draft, type RsvpPage } from './api'

const session = ref<{ username: string } | null>(null)
const credentials = ref({ username: '', password: '' })
const checkingSession = ref(true)
const sessionPending = ref(false)
const sessionError = ref('')
const tab = ref('content')
const draft = ref<Draft | null>(null)
const savedContent = ref('')
const draftAction = ref('')
const draftError = ref('')
const conflict = ref(false)
const uploads = ref(0)
const rows = ref<RsvpPage | null>(null)
const rsvpError = ref('')
const rsvpLoading = ref(false)
let rsvpRefreshPending = false
let rsvpRequestVersion = 0
const cursors = ref<(string | null)[]>([null])
const filters = ref({ keyword: '', minPartySize: '', maxPartySize: '', dateFrom: '', dateTo: '' })
const appliedFilters = ref('')

const dirty = computed(() => draft.value !== null && JSON.stringify(draft.value.content) !== savedContent.value)
const expired = computed(() => Boolean(draft.value?.expiresAt && Date.parse(draft.value.expiresAt) <= Date.now()))

const slots = [
  { key: 'brand', label: '品牌' },
  { key: 'title', label: '主标题' },
  { key: 'greeting', label: '邀请语' },
  { key: 'details', label: '活动详情' },
] as const
const invitationImages = [
  { key: 'backgroundImageId', label: '邀请函背景' },
  { key: 'leftDoorImageId', label: '左侧门页' },
  { key: 'rightDoorImageId', label: '右侧门页' },
  { key: 'sealImageId', label: '封印图案' },
] as const
const rsvpFields = [
  { key: 'title', label: '回执标题' },
  { key: 'nameLabel', label: '姓名标签' },
  { key: 'phoneLabel', label: '手机号标签' },
  { key: 'partySizeLabel', label: '人数标签' },
  { key: 'submitLabel', label: '提交按钮' },
] as const

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}

function clearSession() {
  rsvpRequestVersion++
  session.value = null
  draft.value = null
  draftError.value = ''
  conflict.value = false
  rows.value = null
  rsvpError.value = ''
  cursors.value = [null]
  filters.value = { keyword: '', minPartySize: '', maxPartySize: '', dateFrom: '', dateTo: '' }
  appliedFilters.value = ''
  tab.value = 'content'
}

function sessionExpired(error: unknown) {
  if (!(error instanceof ApiError && error.status === 401)) return false
  clearSession()
  sessionError.value = '登录已失效，请重新登录。'
  return true
}

async function checkSession() {
  try {
    session.value = await api<{ username: string }>('/session')
    await reloadDraft()
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) sessionError.value = errorMessage(error)
  } finally {
    checkingSession.value = false
  }
}

async function login() {
  if (sessionPending.value) return
  sessionError.value = ''
  sessionPending.value = true
  try {
    session.value = await api<{ username: string }>('/session', 'POST', credentials.value)
    credentials.value.password = ''
    await reloadDraft()
  } catch (error) {
    sessionError.value = errorMessage(error)
  } finally {
    sessionPending.value = false
  }
}

async function confirm(message: string, title: string, button: string) {
  try {
    await ElMessageBox.confirm(message, title, { confirmButtonText: button, cancelButtonText: '取消' })
    return true
  } catch {
    return false
  }
}

async function logout() {
  if (sessionPending.value) return
  if (dirty.value && !await confirm('退出后，当前未保存的修改会丢失。', '退出登录', '退出')) return
  sessionPending.value = true
  try {
    await api('/session', 'DELETE')
    clearSession()
    sessionError.value = ''
  } catch (error) {
    if (!sessionExpired(error)) ElMessage.error(errorMessage(error))
  } finally {
    sessionPending.value = false
  }
}

function applyDraft(next: Draft) {
  draft.value = next
  savedContent.value = JSON.stringify(next.content)
  conflict.value = false
}

function reportDraftError(error: unknown) {
  if (sessionExpired(error)) return
  conflict.value = error instanceof ApiError && error.status === 409
  draftError.value = conflict.value
    ? errorMessage(error) + ' 如草稿已被更新，请重新载入后再保存。'
    : errorMessage(error)
}

async function reloadDraft() {
  if (draftAction.value || uploads.value) return
  if (dirty.value && !await confirm('重新载入会丢失当前未保存的修改。', '重新载入草稿', '重新载入')) return
  draftAction.value = 'reload'
  draftError.value = ''
  try {
    applyDraft(await api<Draft>('/invitation/draft'))
  } catch (error) {
    reportDraftError(error)
  } finally {
    draftAction.value = ''
  }
}

async function saveDraft(publish = false) {
  if (!draft.value || draftAction.value || uploads.value) return
  if (publish && !await confirm(
    draft.value.firstPublishedAt
      ? '发布后，原邀请链接将展示本次内容。'
      : '首次发布后，邀请链接将开放一年。',
    '发布邀请函', '确认发布',
  )) return
  draftAction.value = publish ? 'publish' : 'save'
  draftError.value = ''
  try {
    if (dirty.value) {
      const { revision, content } = draft.value
      applyDraft(await api<Draft>('/invitation/draft', 'PUT', { revision, content }))
    }
    if (publish) {
      applyDraft(await api<Draft>('/invitation/publish', 'POST', { revision: draft.value.revision }))
    }
    ElMessage.success(publish ? '邀请函已发布' : '草稿已保存')
  } catch (error) {
    reportDraftError(error)
  } finally {
    draftAction.value = ''
  }
}

function setSlotType(key: typeof slots[number]['key'], type: 'text' | 'image') {
  if (!draft.value) return
  const slot = draft.value.content.invitation[key]
  if (slot.type === type) return
  draft.value.content.invitation[key] = slot.type === 'text'
    ? { type: 'image', assetId: '', alt: slot.text }
    : { type: 'text', text: slot.alt }
}

function addPage(content: Content) {
  content.displayPages.push({
    id: crypto.randomUUID(), title: '', body: '', imageId: null,
  })
}

async function loadRsvps(targetCursors = cursors.value, filterQuery = appliedFilters.value, silent = false) {
  if (rsvpLoading.value || (silent && rsvpRefreshPending)) return
  const version = ++rsvpRequestVersion
  if (silent) rsvpRefreshPending = true
  else rsvpLoading.value = true
  const cursor = targetCursors.at(-1)
  const query = new URLSearchParams(filterQuery)
  query.set('limit', '50')
  if (cursor) query.set('beforeId', cursor)
  try {
    const result = await api<RsvpPage>('/rsvps?' + query)
    if (version !== rsvpRequestVersion || !session.value) return
    rows.value = result
    rsvpError.value = ''
    cursors.value = targetCursors
    appliedFilters.value = filterQuery
  } catch (error) {
    if (version === rsvpRequestVersion && !sessionExpired(error)) rsvpError.value = errorMessage(error)
  } finally {
    if (silent) rsvpRefreshPending = false
    else rsvpLoading.value = false
  }
}

function applyFilters() {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filters.value)) if (value) query.set(key, value)
  void loadRsvps([null], query.toString())
}

function resetFilters() {
  filters.value = { keyword: '', minPartySize: '', maxPartySize: '', dateFrom: '', dateTo: '' }
  void loadRsvps([null], '')
}

function nextRsvps() {
  if (rows.value?.nextCursor) void loadRsvps([...cursors.value, rows.value.nextCursor])
}

function refreshVisibleRsvps() {
  if (session.value && tab.value === 'rsvps' && document.visibilityState === 'visible') void loadRsvps(cursors.value, appliedFilters.value, true)
}

let refreshTimer: ReturnType<typeof setInterval>
onMounted(() => {
  void checkSession()
  refreshTimer = setInterval(refreshVisibleRsvps, 5000)
  document.addEventListener('visibilitychange', refreshVisibleRsvps)
})
onUnmounted(() => {
  clearInterval(refreshTimer)
  document.removeEventListener('visibilitychange', refreshVisibleRsvps)
})
</script>

<template>
  <main v-if="checkingSession" class="shell"><p role="status">正在连接后台…</p></main>

  <main v-else-if="!session" class="login">
    <h1>邀请函管理</h1>
    <el-alert v-if="sessionError" :title="sessionError" type="error" :closable="false" show-icon />
    <el-form label-position="top" @submit.prevent="login">
      <el-form-item label="管理员账号" for="admin-username">
        <el-input id="admin-username" v-model="credentials.username" autocomplete="username" required />
      </el-form-item>
      <el-form-item label="密码" for="admin-password">
        <el-input id="admin-password" v-model="credentials.password" type="password" autocomplete="current-password" required />
      </el-form-item>
      <el-button native-type="submit" type="primary" :loading="sessionPending">登录</el-button>
    </el-form>
  </main>

  <template v-else>
    <header class="topbar">
      <div class="shell topbar-inner">
        <h1>邀请函管理</h1>
        <div class="actions">
          <span>{{ session.username }}</span>
          <el-button plain :loading="sessionPending" :disabled="!!draftAction || uploads > 0 || rsvpLoading" @click="logout">退出登录</el-button>
        </div>
      </div>
    </header>

    <main class="shell">
      <el-tabs v-model="tab" @tab-change="tab === 'rsvps' && loadRsvps([null])">
        <el-tab-pane label="邀请函内容" name="content">
          <div class="draft-toolbar">
            <div class="publication" v-if="draft">
              <el-tag disable-transitions :type="expired ? 'danger' : draft.firstPublishedAt ? 'success' : 'info'">
                {{ expired ? '已到期' : draft.firstPublishedAt ? '已发布' : '未发布' }}
              </el-tag>
              <span v-if="draft.expiresAt">开放至 {{ formatDate(draft.expiresAt) }}</span>
              <span v-if="dirty" class="unsaved" role="status">有未保存的修改</span>
            </div>
            <div class="actions">
              <el-button :loading="draftAction === 'reload'" :disabled="!!draftAction || uploads > 0" @click="reloadDraft">重新载入</el-button>
              <el-button :loading="draftAction === 'save'" :disabled="!dirty || !!draftAction || uploads > 0" @click="saveDraft()">保存草稿</el-button>
              <el-button type="primary" :loading="draftAction === 'publish'" :disabled="!draft || expired || !!draftAction || uploads > 0" @click="saveDraft(true)">发布</el-button>
            </div>
          </div>

          <el-alert v-if="draftError" :title="draftError" type="error" :closable="false" show-icon />
          <fieldset v-if="draft" class="editor" :disabled="!!draftAction">
            <section class="editor-section" aria-labelledby="invitation-heading">
              <h2 id="invitation-heading">邀请函首页</h2>
              <div class="grid">
                <div class="slot" v-for="{ key, label } in slots" :key="key">
                  <div class="slot-heading">
                    <h3>{{ label }}</h3>
                    <el-select :disabled="uploads > 0 || !!draftAction" :model-value="draft.content.invitation[key].type" :aria-label="label + '显示方式'" @change="setSlotType(key, $event)">
                      <el-option label="文字" value="text" />
                      <el-option label="图片" value="image" />
                    </el-select>
                  </div>
                  <template v-if="draft.content.invitation[key].type === 'text'">
                    <el-input v-model="draft.content.invitation[key].text" type="textarea" :rows="2" :aria-label="label" />
                  </template>
                  <template v-else>
                    <el-input v-model="draft.content.invitation[key].alt" placeholder="图片说明" :aria-label="label + '图片说明'" />
                    <AssetField :label="label + '图片'" :model-value="draft.content.invitation[key].assetId || null"
                      @update:model-value="draft.content.invitation[key].assetId = $event || ''"
                      @busy="uploads += $event ? 1 : -1" @error="reportDraftError" />
                  </template>
                </div>
              </div>
              <div class="grid media-grid">
                <AssetField v-for="{ key, label } in invitationImages" :key="key" :label="label"
                  v-model="draft.content.invitation[key]" allow-clear @busy="uploads += $event ? 1 : -1" @error="reportDraftError" />
              </div>
            </section>

            <section class="editor-section" aria-labelledby="display-heading">
              <div class="section-heading">
                <h2 id="display-heading">展示页</h2>
                <el-button plain @click="addPage(draft.content)">追加展示页</el-button>
              </div>
              <p v-if="!draft.content.displayPages.length" class="muted">暂无展示页</p>
              <div v-for="(page, index) in draft.content.displayPages" :key="page.id" class="display-page">
                <div class="section-heading">
                  <h3>{{ page.title || '展示页 ' + (index + 1) }}</h3>
                  <el-button plain size="small" :disabled="uploads > 0" @click="draft.content.displayPages.splice(index, 1)">移除</el-button>
                </div>
                <div class="grid">
                  <el-form label-position="top">
                    <el-form-item label="标题" :for="page.id + '-title'">
                      <el-input :id="page.id + '-title'" v-model="page.title" />
                    </el-form-item>
                    <el-form-item label="正文" :for="page.id + '-body'">
                      <el-input :id="page.id + '-body'" v-model="page.body" type="textarea" :rows="4" />
                    </el-form-item>
                  </el-form>
                  <AssetField label="展示页图片" v-model="page.imageId" allow-clear
                    @busy="uploads += $event ? 1 : -1" @error="reportDraftError" />
                </div>
              </div>
            </section>

            <section class="editor-section" aria-labelledby="venue-heading">
              <h2 id="venue-heading">地点页</h2>
              <div class="grid">
                <el-form label-position="top">
                  <el-form-item label="页面标题" for="venue-title">
                    <el-input id="venue-title" v-model="draft.content.venue.title" />
                  </el-form-item>
                  <el-form-item label="地点名称" for="venue-name">
                    <el-input id="venue-name" v-model="draft.content.venue.name" />
                  </el-form-item>
                  <el-form-item label="地址" for="venue-address">
                    <el-input id="venue-address" v-model="draft.content.venue.address" />
                  </el-form-item>
                </el-form>
                <AssetField label="地点图片" v-model="draft.content.venue.imageId" allow-clear
                  @busy="uploads += $event ? 1 : -1" @error="reportDraftError" />
              </div>
            </section>

            <section class="editor-section" aria-labelledby="rsvp-heading">
              <h2 id="rsvp-heading">回执页</h2>
              <el-form class="grid" label-position="top">
                <el-form-item v-for="{ key, label } in rsvpFields" :key="key" :label="label" :for="'rsvp-' + key">
                  <el-input :id="'rsvp-' + key" v-model="draft.content.rsvp[key]" />
                </el-form-item>
              </el-form>
            </section>

            <section class="editor-section" aria-labelledby="music-heading">
              <h2 id="music-heading">背景音乐</h2>
              <div class="grid">
                <AssetField label="背景音乐（MP3）" v-model="draft.content.bgmId" audio allow-clear
                  @busy="uploads += $event ? 1 : -1" @error="reportDraftError" />
              </div>
            </section>
          </fieldset>
        </el-tab-pane>

        <el-tab-pane label="出席回执" name="rsvps">
          <div class="section-heading rsvp-heading">
            <h2>出席回执</h2>
          </div>
          <el-form class="rsvp-filters" inline label-position="top" @submit.prevent="applyFilters">
            <el-form-item label="姓名或手机号" for="rsvp-keyword">
              <el-input id="rsvp-keyword" v-model="filters.keyword" maxlength="100" :disabled="rsvpLoading" clearable placeholder="输入关键词" />
            </el-form-item>
            <el-form-item label="最少出行人数" for="min-party-size">
              <el-input id="min-party-size" v-model="filters.minPartySize" type="number" min="1" step="1" :disabled="rsvpLoading" placeholder="不限" />
            </el-form-item>
            <el-form-item label="最多出行人数" for="max-party-size">
              <el-input id="max-party-size" v-model="filters.maxPartySize" type="number" min="1" step="1" :disabled="rsvpLoading" placeholder="不限" />
            </el-form-item>
            <el-form-item label="提交起始日期" for="date-from">
              <el-input id="date-from" v-model="filters.dateFrom" type="date" :disabled="rsvpLoading" />
            </el-form-item>
            <el-form-item label="提交结束日期" for="date-to">
              <el-input id="date-to" v-model="filters.dateTo" type="date" :disabled="rsvpLoading" />
            </el-form-item>
            <el-form-item class="filter-actions">
              <el-button native-type="submit" type="primary" :loading="rsvpLoading">筛选</el-button>
              <el-button :disabled="rsvpLoading" @click="resetFilters">重置</el-button>
            </el-form-item>
          </el-form>
          <div v-if="rows" class="rsvp-summary" role="status">
            <span>全部出行人数 <strong>{{ rows.totalPartySize }}</strong> 人</span>
            <span v-if="appliedFilters">筛选出行人数 <strong>{{ rows.filteredPartySize }}</strong> 人</span>
            <span>共 <strong>{{ rows.filteredRecords }}</strong> 条回执</span>
          </div>
          <el-alert v-if="rsvpError" :title="rsvpError" type="error" :closable="false" show-icon />
          <el-table v-if="rows" :data="rows.items" empty-text="暂无回执">
            <el-table-column prop="name" label="姓名" min-width="120" />
            <el-table-column prop="phone" label="手机号" min-width="160" />
            <el-table-column prop="partySize" label="出行人数" min-width="155" />
            <el-table-column label="提交时间" min-width="180">
              <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
            </el-table-column>
          </el-table>
          <p v-else-if="rsvpLoading" role="status">正在读取回执…</p>
          <nav v-if="rows" class="actions pagination" aria-label="回执分页">
            <el-button :disabled="rsvpLoading || cursors.length < 2" @click="loadRsvps(cursors.slice(0, -1))">上一页</el-button>
            <span>第 {{ cursors.length }} 页</span>
            <el-button :disabled="rsvpLoading || !rows.nextCursor" @click="nextRsvps">下一页</el-button>
          </nav>
        </el-tab-pane>
      </el-tabs>
    </main>
  </template>
</template>

<style scoped>
.rsvp-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-bottom: 12px; }
.rsvp-filters :deep(.el-form-item) { flex: 1 1 140px; min-width: 0; margin: 0; }
.rsvp-filters :deep(.el-input) { width: 100%; }
.rsvp-filters :deep(.filter-actions) { flex: 0 0 auto; }
.rsvp-filters :deep(.filter-actions .el-form-item__content) { flex-wrap: nowrap; }
.rsvp-summary { display: flex; align-items: baseline; gap: 28px; padding: 16px 20px; margin-bottom: 16px; background: #e5efeb; border-radius: 6px; overflow-x: auto; }
.rsvp-summary > span { display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap; }
.rsvp-summary strong { font-size: 24px; line-height: 1.2; color: #164d42; font-variant-numeric: tabular-nums; }
</style>
