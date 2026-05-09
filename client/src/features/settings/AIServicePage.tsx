// AI 服务配置页面

import AIProviderSection from './AIProviderSection'

export default function AIServicePage() {
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-2xl font-bold">AI 供应商</h1>
      <div className="space-y-6">
        <AIProviderSection />
      </div>
    </div>
  )
}
