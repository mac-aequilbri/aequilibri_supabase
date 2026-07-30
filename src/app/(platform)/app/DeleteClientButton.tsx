// Confirm-gated delete control for the org picker. The server action is
// passed in from the (server) picker page. The two-step ConfirmSubmitButton
// guards against accidental offboarding — this is a destructive admin action.

import { ConfirmSubmitButton } from "@/components/form/ConfirmSubmitButton";

interface Props {
  action: (formData: FormData) => void | Promise<void>;
  slug: string;
  name: string;
}

export function DeleteClientButton({ action, slug, name }: Props) {
  return (
    <form action={action}>
      <input type="hidden" name="slug" value={slug} />
      <ConfirmSubmitButton
        label="🗑 Delete client"
        confirmLabel="Confirm — removes from registry"
        pendingLabel="Removing…"
        className="btn-ae-danger-outline"
        title={`Removes "${name}" from the picker. Its tenant data is NOT deleted — the org is deactivated and can be restored.`}
      />
    </form>
  );
}
