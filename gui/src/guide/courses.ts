export type CourseId = 'basic' | 'tomato'
export const courseTitle = (course: CourseId) => course === 'basic' ? '通用机器人教程' : '番茄采摘教程'

// Kept for backward-compatible page events without coupling tutorial state to actual robot screens
export function guideCompleted(event: string) {
  window.dispatchEvent(new CustomEvent<string>('agro:guide-complete', { detail: event }))
}
