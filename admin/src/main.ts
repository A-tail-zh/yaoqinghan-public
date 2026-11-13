import { createApp } from 'vue'
import {
  ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElMessage, ElMessageBox,
  ElOption, ElSelect, ElTable, ElTableColumn, ElTabPane, ElTabs, ElTag,
} from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import './style.css'

const app = createApp(App)
for (const component of [
  ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElOption, ElSelect,
  ElTable, ElTableColumn, ElTabPane, ElTabs, ElTag,
]) {
  app.component(component.name!, component)
}
app.use(ElMessage)
app.use(ElMessageBox)
app.mount('#app')
