import type { ConfigApi, ExtractApi, SourceApi, SystemApi } from '@shared/api'

declare global {
  interface Window {
    api: {
      config: ConfigApi
      source: SourceApi
      extract: ExtractApi
      system: SystemApi
      platform: string
    }
  }
}
