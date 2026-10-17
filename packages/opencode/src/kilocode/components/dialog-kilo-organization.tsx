/**
 * Kilo Gateway Organization Selection Dialog
 *
 * Shows organization selection after OAuth authentication when user has multiple organizations.
 * Pre-selects the first organization by default.
 */

import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useToast } from "@tui/ui/toast"
import { DialogSelect } from "@tui/ui/dialog-select"
import type { Organization } from "@kilocode/kilo-gateway"
import { getOrganizationOptions, getDefaultOrganizationSelection } from "@kilocode/kilo-gateway/tui"
import { useAuthRefresh } from "../tui/auth-refresh"

// These types are OpenCode-internal and imported at runtime
type UseSDK = any
type UseTheme = any
type DialogModel = any

interface DialogKiloOrganizationProps {
  organizations: Organization[]
  userEmail: string
  providerID: string
  useSDK: () => UseSDK
  useTheme: () => UseTheme
  DialogModel: DialogModel
}

export function DialogKiloOrganization(props: DialogKiloOrganizationProps) {
  const dialog = useDialog()
  const sync = useSync()
  const auth = useAuthRefresh(sync)
  const sdk = props.useSDK()
  const toast = useToast()

  // Get formatted options with current markers
  const options = getOrganizationOptions(props.organizations)

  // Pre-select first organization (user requirement)
  const defaultSelection = getDefaultOrganizationSelection(props.organizations)

  return (
    <DialogSelect
      title={`Select Account (${props.userEmail})`}
      options={options}
      current={defaultSelection}
      onSelect={async (option: any) => {
        if (!auth.current()) return
        try {
          const orgId = option.value

          // Update auth to include organization ID using server endpoint
          await sdk.client.kilo.organization.set({ organizationId: orgId }, { throwOnError: true })

          // Refresh provider state to reload with new organization context
          if (!(await auth.refresh())) return

          // Proceed to model selection
          dialog.replace(() => <props.DialogModel providerID={props.providerID} />)
        } catch (error) {
          if (!auth.current()) return
          if (error instanceof DOMException && error.name === "AbortError") return
          console.warn("Failed to set organization:", error)
          toast.show({
            message: "Failed to set organization; continuing with current account",
            variant: "warning",
          })
          dialog.replace(() => <props.DialogModel providerID={props.providerID} />)
        }
      }}
    />
  )
}
