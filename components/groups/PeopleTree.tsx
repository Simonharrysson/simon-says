import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { Field } from "@/components/ui/Field";
import { IconPlus } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { PlaceSelect } from "@/components/foretag/PlaceSelect";
import { parentChoices, treeRows } from "@/lib/foretag/tree";
import { asTreeRows, type TreePersonView } from "@/lib/groups/people";

// The people tree as a list (0062): the phone view, and "Lista" on a desktop. Who reports to whom,
// indented, never a group name. Admins choose "Rapporterar till" per person (a real form post, so it
// works before hydration) and add people; everyone else reads. The database decides every write.

export interface PeopleTreeActions {
  setManager: FormAction;
  addPerson: FormAction;
}

export interface PeopleTreeProps {
  orgId: string;
  isAdmin: boolean;
  people: TreePersonView[];
  actions: PeopleTreeActions;
  /** Hidden fields every form sends along (a förening: `from=forening`, so errors come back to Inställningar). */
  hidden?: Record<string, string>;
}

export function PeopleTree({ orgId, isAdmin, people, actions, hidden = {} }: PeopleTreeProps) {
  const t = useTranslations("foretag.tree");
  const rows = treeRows(asTreeRows(people));
  const byId = new Map(people.flatMap((p) => (p.personId ? [[p.personId, p] as const] : [])));
  const unplaced = people.filter((p) => !p.placed);
  const reports = (id: string) => people.filter((p) => p.managerId === id).length;
  const indent = (n: number) => " ".repeat(n);
  const choices = (personId: string | null) => {
    const allowed = personId ? parentChoices(asTreeRows(people), personId) : asTreeRows(people);
    const ok = new Set(allowed.map((g) => g.id));
    return [
      { value: "top", label: t("top") },
      { value: "none", label: t("none") },
      ...rows.filter((r) => ok.has(r.group.id)).map((r) => ({ value: r.group.id, label: `${indent(r.depth)}${r.group.name}` })),
    ];
  };

  const line = (p: TreePersonView, depth: number) => {
    const value = !p.placed ? "none" : (p.managerId ?? "top");
    const who: Record<string, string> = p.personId ? { personId: p.personId } : { userId: p.userId!, name: p.email?.split("@")[0] ?? p.name };
    return (
      <li
        key={p.key}
        data-person-row={p.name}
        style={{ marginInlineStart: `${Math.min(depth, 6) * 1.25}rem` }}
        className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-2 first:border-t-0"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium wrap-anywhere">{p.name}</span>
          {p.role && <span className="text-sm text-ink-2">{p.role}</span>}
          {/* A person's invite e-mail is the admins' business (members see names). */}
          {isAdmin && p.personId && p.email && p.email !== p.name && <span className="text-sm text-ink-3 wrap-anywhere">{p.email}</span>}
          {p.you && <span className="text-sm text-ink-3">{t("youMark")}</span>}
          {p.admin && <Badge tone="info">{t("admin")}</Badge>}
          {p.personId && p.placed && reports(p.personId) > 0 && <span className="text-xs text-ink-3">{t("reports", { count: reports(p.personId) })}</span>}
        </span>
        {isAdmin && (
          <PlaceSelect
            action={actions.setManager}
            hidden={{ ...hidden, orgId, ...who }}
            name="to"
            value={value}
            options={choices(p.personId)}
            label={t("reportsToFor", { name: p.name })}
            savingLabel={t("moving")}
          />
        )}
      </li>
    );
  };

  return (
    <>
      <Panel title={t("title")} titleId="people-tree-title">
        {rows.length ? (
          <ol aria-labelledby="people-tree-title" className="flex flex-col">
            {rows.map(({ group, depth }) => line(byId.get(group.id)!, depth))}
          </ol>
        ) : (
          <p className="text-sm text-ink-3">{t("unplacedEmpty")}</p>
        )}
      </Panel>

      {unplaced.length > 0 && (
        <Panel title={t("unplaced")} titleId="people-unplaced-title">
          <p className="-mt-2 mb-3 text-sm text-ink-2">{t("unplacedText")}</p>
          <ul aria-labelledby="people-unplaced-title">{unplaced.map((p) => line(p, 0))}</ul>
        </Panel>
      )}

      {isAdmin && (
        <Panel title={t("addPerson")} titleId="add-person-title">
          <form action={actions.addPerson} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="orgId" value={orgId} />
            {Object.entries(hidden).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <Field id="person-name" name="name" label={t("name")} required maxLength={100} className="min-w-[12rem] flex-1" />
            <Field id="person-email" name="email" type="email" label={t("email")} maxLength={254} className="min-w-[12rem] flex-1" />
            <Field id="person-role" name="role" label={t("role")} maxLength={40} className="min-w-[10rem] flex-1" />
            <div className="flex min-w-[12rem] flex-1 flex-col gap-2">
              <Label htmlFor="person-manager">{t("reportsTo")}</Label>
              <NativeSelect id="person-manager" name="to" defaultValue="top">
                {choices(null).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <SubmitButton variant="primary" icon={<IconPlus />} pendingLabel={t("adding")} className="max-sm:w-full">
              {t("add")}
            </SubmitButton>
          </form>
        </Panel>
      )}
    </>
  );
}
