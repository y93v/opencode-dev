import "@/index.css"
import "@/devcode-studio.css"
import { DevcodeToolbar } from "@/devcode-toolbar"
import { DevcodeThemeProvider } from "@/devcode-theme-provider"
import { DevcodeResetFab, DevcodeWebsiteFab } from "@/devcode-reset-fab"
import { DevcodeLicenseFab } from "@/devcode-license-fab"
import { DevcodeUpdateFab } from "@/devcode-update-fab"
import { DevcodeVersionBadge } from "@/devcode-version-badge"
import { DevcodeThemeFab } from "@/devcode-theme-fab"
import { FREE_EDITION } from "@/devcode-edition"
import { VoiceProvider } from "@/voice/context"
import { VoiceOverlay } from "@/voice/composer"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { Font } from "@opencode/ui/font"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { MetaProvider, Title } from "@solidjs/meta"
import { type BaseRouterProps, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { type Component, createRenderEffect, ErrorBoundary, type JSX, type ParentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider } from "@/shell/commands/command"
import { DesktopCommands } from "@/shell/commands/desktop"
import { ProjectIconsProvider } from "@/shell/layout/project-icons"
import { GlobalProvider } from "@/runtime/server/runtime"
import { LanguageProvider, UiI18nBridge, type Locale } from "@/runtime/i18n/language"
import { ServerConnection, ServersProvider } from "@/runtime/server/registry"
import { SettingsProvider } from "@/settings/model"
import { TabsProvider } from "@/shell/tabs/tabs"
import { ErrorPage } from "@/shell/errors/error"
import { AppRoutes, File, preloadRoute } from "@/shell/routes/routes"
import { PluginRoot } from "@/runtime/plugin/root"

export { preloadRoute }

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
      },
    },
  })

  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyTypography() {
  createRenderEffect(() => {
    if (typeof document === "undefined") return
    document.body.classList.remove("text-12-regular")
    document.body.classList.add("font-(family-name:--font-family-text)", "text-[13px]", "font-[440]")
  })

  return null
}

export function AppBaseProviders(
  props: ParentProps<{
    locale?: Locale
    onNativeTranslations?: Parameters<typeof LanguageProvider>[0]["onNativeTranslations"]
    onThemeApplied?: (mode: "light" | "dark", scheme: "system" | "light" | "dark") => void
  }>,
) {
  return (
    <MetaProvider>
      <Title>OpenCode Dev</Title>
      <Font />
      <ThemeProvider onThemeApplied={(mode, scheme) => props.onThemeApplied?.(mode, scheme)}>
        <DevcodeThemeProvider />
        <LanguageProvider locale={props.locale} onNativeTranslations={props.onNativeTranslations}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                void import("@sentry/solid").then(({ captureException }) => captureException(error))

                return <ErrorPage error={error} />
              }}
            >
              <QueryProvider>
                <DialogProvider>
                  <PluginRoot>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </PluginRoot>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
}) {
  // The visual layout lives in the router root so it remains mounted across
  // route changes. Draft and session routes override only their server-bound data
  // providers beneath it.
  const Root = (rootProps: ParentProps) => (
    <TabsProvider>
      <GlobalProvider>
        <ProjectIconsProvider>
          <BodyTypography />
          <CommandProvider>
            <DesktopCommands />
            <VoiceProvider>
              {props.children}
              {rootProps.children}
              <VoiceOverlay />
              <DevcodeToolbar>
                <DevcodeResetFab />
                <DevcodeThemeFab />
                <DevcodeUpdateFab />
              </DevcodeToolbar>
              <DevcodeVersionBadge />
            </VoiceProvider>
          </CommandProvider>
        </ProjectIconsProvider>
      </GlobalProvider>
    </TabsProvider>
  )

  return (
    <ServersProvider canonicalLocalServer={props.canonicalLocalServer} servers={props.servers}>
      <SettingsProvider>
        <Dynamic component={props.router ?? Router} root={Root}>
          <AppRoutes />
        </Dynamic>
      </SettingsProvider>
    </ServersProvider>
  )
}
