<script setup lang="ts">
import { ref } from 'vue'
import { api } from './api'

const props = defineProps<{ label: string; audio?: boolean; allowClear?: boolean }>()
const assetId = defineModel<string | null>({ required: true })
const emit = defineEmits<{ busy: [boolean]; error: [unknown] }>()
const uploading = ref(false)

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  const body = new FormData()
  body.append('file', file)
  uploading.value = true
  emit('busy', true)
  try {
    const asset = await api<{ id: string; kind: string }>('/assets', 'POST', body)
    if (asset.kind !== (props.audio ? 'audio' : 'image')) {
      throw new Error(props.audio ? '请选择音频文件。' : '请选择图片文件。')
    }
    assetId.value = asset.id
  } catch (error) {
    emit('error', error)
  } finally {
    uploading.value = false
    emit('busy', false)
  }
}
</script>

<template>
  <div class="asset">
    <span>{{ label }}</span>
    <audio v-if="assetId && audio" :src="'/api/admin/assets/' + assetId" controls preload="none" />
    <img v-else-if="assetId" :src="'/api/admin/assets/' + assetId" :alt="label + '预览'" />
    <div v-else class="asset-empty">尚未设置{{ audio ? '音乐' : '图片' }}</div>
    <div class="asset-actions">
      <label class="file-button" :class="{ disabled: uploading }">
        {{ uploading ? '上传中…' : assetId ? '更换文件' : '上传文件' }}
        <span class="sr-only">{{ label }}</span>
        <input type="file" :disabled="uploading" :accept="audio ? 'audio/mpeg' : 'image/jpeg,image/png,image/webp'" @change="upload">
      </label>
      <el-button v-if="assetId && allowClear" size="small" :disabled="uploading" @click="assetId = null">清除</el-button>
    </div>
  </div>
</template>
