import { IconGoogle } from "@/components/ui/icons";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { SubmitButton } from "@/components/ui/SubmitButton";

/** "Logga in med Google" as a form posting `next` to the sign-in action. */
export function GoogleSignIn({ action, next, label = "Logga in med Google" }: { action: FormAction; next: string; label?: string }) {
  return (
    <form action={action}>
      <input type="hidden" name="next" value={next} />
      <SubmitButton variant="primary" size="lg" block icon={<IconGoogle />} pendingLabel="Skickar dig till Google…">
        {label}
      </SubmitButton>
    </form>
  );
}
