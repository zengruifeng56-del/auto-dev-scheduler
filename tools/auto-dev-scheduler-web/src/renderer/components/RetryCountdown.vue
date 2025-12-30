<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{ target: number }>()

const now = ref(Date.now())
let timer: number | undefined

const secondsLeft = computed(() => Math.max(0, Math.ceil((props.target - now.value) / 1000)))
const isDue = computed(() => secondsLeft.value === 0)

onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer !== undefined) {
    clearInterval(timer)
  }
})
</script>

<template>
  <span class="retry-countdown" :class="{ due: isDue }">
    <span v-if="!isDue">&#10227; {{ secondsLeft }}s</span>
    <span v-else>&#10227; ...</span>
  </span>
</template>

<style scoped>
.retry-countdown {
  font-family: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 11px;
  color: var(--vscode-accent-orange, #c88c32);
  background: rgba(200, 140, 50, 0.15);
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 6px;
}

.retry-countdown.due {
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
</style>
