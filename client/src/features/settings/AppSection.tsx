import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useT } from '@/i18n/useT'
import { IS_MAC } from '@/lib/platform'

/**
 * 这里曾经还有一个「自动检测更新」开关。撤掉了：更新现在是必走的 ——
 * 后台静默下载，用户点左下角图标、或下次关闭应用时装上。
 * 底层设置项 autoCheckUpdate 仍然被读取（见 features/update/autoUpdate.ts），
 * 只是不再暴露给用户，留作更新链路自身出故障时的远程止血开关。
 */
export default function AppSection({
  autoLaunch,
  onToggleAutoLaunch,
  ready = true,
  animate = true,
}: {
  autoLaunch: boolean
  onToggleAutoLaunch: () => void
  ready?: boolean
  animate?: boolean
}) {
  const t = useT()
  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('settings.app.title')}</h2>
        <div className="flex items-center justify-between">
          <div>
            {/* mac 上叫「登录时打开」，没有「开机」这个说法 */}
            <p className="text-sm font-medium">{t(IS_MAC ? 'settings.app.autoLaunchMac' : 'settings.app.autoLaunch')}</p>
            <p className="text-xs text-muted-foreground">{t(IS_MAC ? 'settings.app.autoLaunchDescMac' : 'settings.app.autoLaunchDesc')}</p>
          </div>
          <Switch checked={autoLaunch} onChange={onToggleAutoLaunch} noAnimation={!animate} hidden={!ready} />
        </div>
      </CardContent>
    </Card>
  )
}
