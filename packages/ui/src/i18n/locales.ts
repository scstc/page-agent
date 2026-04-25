// English translations (base/reference language)
const enUS = {
	ui: {
		panel: {
			ready: 'Ready',
			thinking: 'Thinking...',
			send: 'Send',
			taskInput: 'Enter new task. Enter to send, Shift+Enter for newline',
			userAnswerPrompt: 'Please answer the question above. Enter to send, Shift+Enter for newline',
			taskTerminated: 'Task terminated',
			taskCompleted: 'Task completed',
			userAnswer: 'User answer: {{input}}',
			question: 'Question: {{question}}',
			waitingPlaceholder: 'Waiting for task to start...',
			stop: 'Stop',
			close: 'Close',
			expand: 'Expand history',
			collapse: 'Collapse history',
			step: 'Step {{number}}',
			settings: 'Settings',
			settingsTitle: 'Settings',
			settingsTabLLM: 'LLM',
			settingsTabQuickTasks: 'Quick Tasks',
			settingsModel: 'Model',
			settingsBaseURL: 'Base URL',
			settingsApiKey: 'API Key',
			settingsSave: 'Save',
			settingsCancel: 'Cancel',
			settingsHint: 'Changes take effect on the next task. Stored locally in this browser.',
			settingsImport: 'Import JSON',
			settingsImportError: 'Invalid JSON config',
			quickTasks: 'Quick tasks',
			quickTasksHint:
				'Save up to {{max}} reusable tasks. Click one in the header menu to run its content.',
			quickTasksAdd: 'Add',
			quickTasksRemove: 'Remove',
			quickTasksNamePlaceholder: 'Name (max {{max}} chars)',
			quickTasksContentPlaceholder:
				'Task content — sent to the agent on click. Shift+Enter for newline.',
			quickTasksEmpty: 'No quick tasks yet',
			quickTasksLimit: 'Limit reached ({{max}})',
		},
		tools: {
			clicking: 'Clicking element [{{index}}]...',
			inputting: 'Inputting text to element [{{index}}]...',
			selecting: 'Selecting option "{{text}}"...',
			scrolling: 'Scrolling page...',
			waiting: 'Waiting {{seconds}} seconds...',
			askingUser: 'Asking user...',
			done: 'Task done',
			clicked: '🖱️ Clicked element [{{index}}]',
			inputted: '⌨️ Inputted text "{{text}}"',
			selected: '☑️ Selected option "{{text}}"',
			scrolled: '🛞 Page scrolled',
			waited: '⌛️ Wait completed',
			executing: 'Executing {{toolName}}...',
			resultSuccess: 'success',
			resultFailure: 'failed',
			resultError: 'error',
		},
		errors: {
			elementNotFound: 'No interactive element found at index {{index}}',
			taskRequired: 'Task description is required',
			executionFailed: 'Task execution failed',
			notInputElement: 'Element is not an input or textarea',
			notSelectElement: 'Element is not a select element',
			optionNotFound: 'Option "{{text}}" not found',
		},
	},
} as const

// Chinese translations (must match the structure of enUS)
const zhCN = {
	ui: {
		panel: {
			ready: '准备就绪',
			thinking: '正在思考...',
			send: '发送',
			taskInput: '输入新任务，回车发送，Shift+Enter 换行',
			userAnswerPrompt: '请回答上面问题，回车发送，Shift+Enter 换行',
			taskTerminated: '任务已终止',
			taskCompleted: '任务结束',
			userAnswer: '用户回答: {{input}}',
			question: '询问: {{question}}',
			waitingPlaceholder: '等待任务开始...',
			stop: '终止',
			close: '关闭',
			expand: '展开历史',
			collapse: '收起历史',
			step: '步骤 {{number}}',
			settings: '设置',
			settingsTitle: '设置',
			settingsTabLLM: '大模型',
			settingsTabQuickTasks: '快捷任务',
			settingsModel: '模型',
			settingsBaseURL: 'Base URL',
			settingsApiKey: 'API Key',
			settingsSave: '保存',
			settingsCancel: '取消',
			settingsHint: '修改将在下一个任务生效，仅保存在当前浏览器。',
			settingsImport: '导入 JSON',
			settingsImportError: '配置 JSON 格式错误',
			quickTasks: '快捷任务',
			quickTasksHint: '最多保存 {{max}} 个常用任务，从顶栏菜单点击即发送任务内容。',
			quickTasksAdd: '添加',
			quickTasksRemove: '删除',
			quickTasksNamePlaceholder: '任务名称（最多 {{max}} 字）',
			quickTasksContentPlaceholder: '任务内容（点击发送），Shift+Enter 换行',
			quickTasksEmpty: '暂无快捷任务',
			quickTasksLimit: '已达上限（{{max}}）',
		},
		tools: {
			clicking: '正在点击元素 [{{index}}]...',
			inputting: '正在输入文本到元素 [{{index}}]...',
			selecting: '正在选择选项 "{{text}}"...',
			scrolling: '正在滚动页面...',
			waiting: '等待 {{seconds}} 秒...',
			askingUser: '正在询问用户...',
			done: '结束任务',
			clicked: '🖱️ 已点击元素 [{{index}}]',
			inputted: '⌨️ 已输入文本 "{{text}}"',
			selected: '☑️ 已选择选项 "{{text}}"',
			scrolled: '🛞 页面滚动完成',
			waited: '⌛️ 等待完成',
			executing: '正在执行 {{toolName}}...',
			resultSuccess: '成功',
			resultFailure: '失败',
			resultError: '错误',
		},
		errors: {
			elementNotFound: '未找到索引为 {{index}} 的交互元素',
			taskRequired: '任务描述不能为空',
			executionFailed: '任务执行失败',
			notInputElement: '元素不是输入框或文本域',
			notSelectElement: '元素不是选择框',
			optionNotFound: '未找到选项 "{{text}}"',
		},
	},
} as const

// Type definitions generated from English base structure (but with string values)
type DeepStringify<T> = {
	[K in keyof T]: T[K] extends string ? string : T[K] extends object ? DeepStringify<T[K]> : T[K]
}

export type TranslationSchema = DeepStringify<typeof enUS>

// Utility type: Extract all nested paths from translation object
type NestedKeyOf<ObjectType extends object> = {
	[Key in keyof ObjectType & (string | number)]: ObjectType[Key] extends object
		? `${Key}` | `${Key}.${NestedKeyOf<ObjectType[Key]>}`
		: `${Key}`
}[keyof ObjectType & (string | number)]

// Extract all possible key paths from translation structure
export type TranslationKey = NestedKeyOf<TranslationSchema>

// Parameterized translation types
export type TranslationParams = Record<string, string | number>

export const locales = {
	'en-US': enUS,
	'zh-CN': zhCN,
} as const

export type SupportedLanguage = keyof typeof locales
