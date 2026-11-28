import { useTranslations } from "next-intl";
import { ButtonLink, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight, IconGoogle } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";

export interface StartActionProps {
  /** Signed in: the way into the app instead of the sign-in. */
  signedIn: boolean;
  signIn: FormAction;
  size?: ButtonSize;
  /** The Google G in front (the hero and the closing call to action). */
  google?: boolean;
  block?: boolean;
  /** "secondary" on the dark closing panel. */
  variant?: ButtonVariant;
}

/**
 * The page's one action: "Kom igång gratis" (Google sign-in, then Hem), or "Till appen" when
 * already signed in. Works in server and client components (the sheet menu).
 */
export function StartAction({ signedIn, signIn, size = "lg", google = false, block = false, variant = "primary" }: StartActionProps) {
  const t = useTranslations("landing");
  const login = useTranslations("login");
  if (signedIn) {
    return (
      <ButtonLink href="/hem" variant={variant} size={size} block={block} icon={size === "lg" ? <IconArrowRight /> : undefined}>
        {t("toApp")}
      </ButtonLink>
    );
  }
  return (
    <form action={signIn} className={block ? "w-full" : undefined}>
      <input type="hidden" name="next" value="/hem" />
      <SubmitButton variant={variant} size={size} block={block} icon={google ? <IconGoogle /> : undefined} pendingLabel={login("sendingToGoogle")}>
        {t("start")}
      </SubmitButton>
    </form>
  );
}
