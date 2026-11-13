import { useId } from "react";
import { TbDatabaseExport, TbDots, TbFileTypeCsv } from "react-icons/tb";
import type { CategoryParent } from "../../db/queries/overview.ts";
import {
  resolvePeriod,
  today,
  type DateRange,
  type NaiveDate,
  type PeriodChoice,
  type Preset,
} from "../../lib/period.ts";
import {
  categoryTree,
  listedIn,
  listedValues,
  namesIn,
  type CategoryNode,
} from "./categoryTree.ts";
import HeaderMenu, {
  ActionItem,
  CheckAll,
  CheckboxItem,
  ItemDetails,
  MenuButton,
  MenuGroup,
  RadioItem,
  type GridMenuProps,
  type HeaderProps,
} from "./HeaderMenu.tsx";
import {
  sortedBy,
  type FilterValues,
  type Flow,
  type MenuColumn,
  type SortColumn,
  type SortDirection,
  type TransactionsView,
} from "./view.ts";

type MenuProps = {
  header: HeaderProps;
  view: TransactionsView;
  onViewChange: (view: TransactionsView) => void;
};

type ColumnMenuProps = MenuProps & {
  column: MenuColumn;
  /** Every account's name, as listed. */
  accounts: readonly string[];
  /** Every category, as listed. */
  categories: readonly CategoryParent[];
  values: FilterValues;
};

/** The header of a column that sorts or filters the transactions. */
export function ColumnMenu({ column, accounts, categories, values, ...props }: ColumnMenuProps) {
  switch (column) {
    case "date":
      return <DateMenu {...props} />;
    case "account":
      return <AccountMenu {...props} accounts={accounts} />;
    case "counterparty":
      return <CounterpartyMenu {...props} />;
    case "category":
      return <CategoryMenu {...props} categories={categories} used={values.categories} />;
    case "amount":
      return <AmountMenu {...props} currencies={values.currencies} />;
    case "remarks":
      return <RemarksMenu {...props} />;
  }
}

/**
 * What the table's menu shows in the corner: dots, at the end, as the
 * numbers below are, so the dots end where they do, as the icon has room
 * either side of them.
 */
export function TableMenuFace() {
  return <TbDots aria-hidden className="mr-1.5 ml-auto shrink-0 text-base" />;
}

/**
 * The menu in the corner over the row numbers, for the table as a whole.
 * `onExportDatabase` downloads the database as an SQLite file, and
 * `onExportCsv` the transactions shown as CSV.
 */
export function TableMenu({
  header,
  view,
  onViewChange,
  onExportDatabase,
  onExportCsv,
}: Omit<MenuProps, "header"> & {
  header: GridMenuProps;
  onExportDatabase: () => void;
  onExportCsv: () => void;
}) {
  return (
    <MenuButton {...header} anchor="corner" name="Table options" face={<TableMenuFace />}>
      <MenuGroup title="Filter">
        <CheckboxItem
          label="Show duplicate transactions"
          checked={view.showDuplicates}
          onToggle={(showDuplicates) => onViewChange({ ...view, showDuplicates })}
        />
      </MenuGroup>
      <MenuGroup title="Export">
        <ActionItem
          label="Export as SQLite database"
          icon={TbDatabaseExport}
          onPick={onExportDatabase}
        />
        <ActionItem label="Export as CSV" icon={TbFileTypeCsv} onPick={onExportCsv} />
      </MenuGroup>
    </MenuButton>
  );
}

/** Whether a filter by `values` hides any of them. */
function hidesAny<T>(values: readonly T[], hidden: ReadonlySet<T>) {
  return values.some((value) => hidden.has(value));
}

/** "Show all" first, as it is to begin with. There's room to say what "Last year" is. */
const DATE_FILTERS = [
  { id: "all", label: "Show all" },
  { id: "this-month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "last-3-months", label: "Last 3 months" },
  { id: "last-6-months", label: "Last 6 months" },
  { id: "last-12-months", label: "Last 12 months" },
] as const satisfies readonly { id: Preset; label: string }[];

/** The months `preset` covers on `now`, e.g. "October 2026" or "Aug – Oct 2026". */
const coveredMonths = (preset: Preset, now: NaiveDate) =>
  resolvePeriod({ kind: preset }, now, { first: null, last: null }).span;

function DateMenu({ header, view, onViewChange }: MenuProps) {
  const sortName = useId();
  const filterName = useId();
  const now = today();
  const sorted = sortedBy(view.sort, "date");
  const { dates } = view;

  const sortBy = (direction: SortDirection) =>
    onViewChange({ ...view, sort: { column: "date", direction } });
  const filterBy = (choice: PeriodChoice) => onViewChange({ ...view, dates: choice });

  /** A custom range starts from the dates shown, or this month's when that's all of them. */
  function chooseCustom() {
    const start = dates.kind === "all" ? { kind: "this-month" as const } : dates;
    const { from, to } = resolvePeriod(start, now, { first: null, last: null });
    filterBy({ kind: "custom", from, to });
  }

  return (
    <HeaderMenu {...header} column="date" sorted={sorted} filtered={dates.kind !== "all"}>
      <MenuGroup title="Sort">
        <RadioItem
          name={sortName}
          label="Recent transactions first"
          checked={sorted === "descending"}
          onPick={() => sortBy("descending")}
        />
        <RadioItem
          name={sortName}
          label="Oldest transactions first"
          checked={sorted === "ascending"}
          onPick={() => sortBy("ascending")}
        />
      </MenuGroup>
      <MenuGroup title="Filter">
        {DATE_FILTERS.map(({ id, label }) => (
          <RadioItem
            key={id}
            name={filterName}
            label={label}
            hint={id === "all" ? undefined : coveredMonths(id, now)}
            checked={dates.kind === id}
            onPick={() => filterBy({ kind: id })}
          />
        ))}
        <RadioItem
          name={filterName}
          label="Custom range"
          checked={dates.kind === "custom"}
          onPick={chooseCustom}
        />
        {dates.kind === "custom" && (
          <CustomRange range={dates} onChange={(range) => filterBy({ kind: "custom", ...range })} />
        )}
      </MenuGroup>
    </HeaderMenu>
  );
}

// Not outline-none: it would also take the style focus-visible's outline draws with.
const dateInputClass =
  "h-7 rounded border border-line bg-field px-1.5 text-xs tabular-nums focus-visible:outline-2 focus-visible:outline-focus";

/** A custom range's dates, under its option. */
function CustomRange({
  range,
  onChange,
}: {
  range: DateRange;
  onChange: (range: DateRange) => void;
}) {
  return (
    <ItemDetails className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 pt-0.5 pb-1.5 text-xs text-ink-muted">
      <label className="contents">
        From
        <input
          type="date"
          value={range.from}
          // Cleared, the date is kept until a new one is picked.
          onChange={(event) =>
            event.target.value && onChange({ ...range, from: event.target.value })
          }
          className={dateInputClass}
        />
      </label>
      <label className="contents">
        To
        <input
          type="date"
          value={range.to}
          onChange={(event) => event.target.value && onChange({ ...range, to: event.target.value })}
          className={dateInputClass}
        />
      </label>
    </ItemDetails>
  );
}

/** Sorting by a column of text, A to Z or Z to A. */
function TextSort({
  column,
  view,
  onViewChange,
}: Omit<MenuProps, "header"> & { column: SortColumn }) {
  const name = useId();
  const sorted = sortedBy(view.sort, column);
  const sortBy = (direction: SortDirection) =>
    onViewChange({ ...view, sort: { column, direction } });

  return (
    <MenuGroup title="Sort">
      <RadioItem
        name={name}
        label="A to Z"
        checked={sorted === "ascending"}
        onPick={() => sortBy("ascending")}
      />
      <RadioItem
        name={name}
        label="Z to A"
        checked={sorted === "descending"}
        onPick={() => sortBy("descending")}
      />
    </MenuGroup>
  );
}

function AccountMenu({
  header,
  view,
  onViewChange,
  accounts,
}: MenuProps & { accounts: readonly string[] }) {
  const hidden = view.hiddenAccounts;
  const hide = (hiddenAccounts: ReadonlySet<string>) => onViewChange({ ...view, hiddenAccounts });

  return (
    <HeaderMenu
      {...header}
      column="account"
      sorted={sortedBy(view.sort, "account")}
      filtered={hidesAny(accounts, hidden)}
    >
      <TextSort column="account" view={view} onViewChange={onViewChange} />
      <MenuGroup title="Filter">
        <CheckAll label="All accounts" values={accounts} hidden={hidden} onHide={hide}>
          {accounts.map((account) => (
            <CheckboxItem
              key={account}
              label={account}
              level={1}
              checked={!hidden.has(account)}
              onToggle={(checked) => hide(toggled(hidden, [account], checked))}
            />
          ))}
        </CheckAll>
      </MenuGroup>
    </HeaderMenu>
  );
}

/** `hidden` with `values` shown, or hidden. */
function toggled<T>(hidden: ReadonlySet<T>, values: readonly T[], show: boolean) {
  const next = new Set(hidden);
  for (const value of values) {
    if (show) next.delete(value);
    else next.add(value);
  }
  return next;
}

function CounterpartyMenu({ header, view, onViewChange }: MenuProps) {
  return (
    <HeaderMenu
      {...header}
      column="counterparty"
      sorted={sortedBy(view.sort, "counterparty")}
      filtered={false}
    >
      <TextSort column="counterparty" view={view} onViewChange={onViewChange} />
    </HeaderMenu>
  );
}

function CategoryMenu({
  header,
  view,
  onViewChange,
  categories,
  used,
}: MenuProps & {
  categories: readonly CategoryParent[];
  /** The categories some transaction is set to; null if one has none. */
  used: ReadonlySet<string | null>;
}) {
  const tree = categoryTree(categories);
  const values = listedValues(tree, used);
  const hidden = view.hiddenCategories;
  const hide = (hiddenCategories: ReadonlySet<string | null>) =>
    onViewChange({ ...view, hiddenCategories });
  const toggle = (names: readonly (string | null)[], show: boolean) =>
    hide(toggled(hidden, names, show));

  return (
    <HeaderMenu
      {...header}
      column="category"
      sorted={sortedBy(view.sort, "category")}
      filtered={hidesAny(values, hidden)}
    >
      <TextSort column="category" view={view} onViewChange={onViewChange} />
      <MenuGroup title="Filter">
        <CheckAll label="All categories" values={values} hidden={hidden} onHide={hide}>
          {tree.map((node) => (
            <CategoryItems
              key={node.name}
              node={node}
              level={1}
              used={used}
              hidden={hidden}
              onToggle={toggle}
            />
          ))}
          {used.has(null) && (
            <CheckboxItem
              label="(no category)"
              level={1}
              checked={!hidden.has(null)}
              onToggle={(checked) => toggle([null], checked)}
            />
          )}
        </CheckAll>
      </MenuGroup>
    </HeaderMenu>
  );
}

/**
 * A category's item, and with subcategories, theirs under it, then "(no
 * subcategory)" for the transactions set to the category itself, if any
 * are. The category's own item checks all of them.
 *
 * A category with just one item under it is shown as that item, named
 * after both: "Health / Pharmacy". So is a chain of them, as one item.
 */
function CategoryItems({
  node,
  level,
  used,
  hidden,
  onToggle,
  above = [],
}: {
  node: CategoryNode;
  level: number;
  used: ReadonlySet<string | null>;
  hidden: ReadonlySet<string | null>;
  onToggle: (names: readonly string[], show: boolean) => void;
  /** The categories above it in its item, each with only it under them. */
  above?: readonly string[];
}) {
  const [only] = node.children;
  if (only && node.children.length === 1 && !used.has(node.name))
    return (
      <CategoryItems
        node={only}
        level={level}
        used={used}
        hidden={hidden}
        onToggle={onToggle}
        above={[...above, node.name]}
      />
    );

  const label = [...above, node.name].join(" / ");
  // Every category under the item, listed or not, so none of their transactions are left out.
  const names = [...above, ...namesIn(node)];
  if (node.children.length === 0)
    return (
      <CheckboxItem
        label={label}
        level={level}
        checked={!hidden.has(node.name)}
        onToggle={(checked) => onToggle(names, checked)}
      />
    );

  const listed = listedIn(node, used);
  const shown = listed.filter((name) => !hidden.has(name)).length;
  return (
    <>
      <CheckboxItem
        label={label}
        level={level}
        checked={shown === listed.length}
        indeterminate={shown > 0 && shown < listed.length}
        onToggle={(checked) => onToggle(names, checked)}
      />
      {node.children.map((child) => (
        <CategoryItems
          key={child.name}
          node={child}
          level={level + 1}
          used={used}
          hidden={hidden}
          onToggle={onToggle}
        />
      ))}
      {used.has(node.name) && (
        <CheckboxItem
          label="(no subcategory)"
          level={level + 1}
          checked={!hidden.has(node.name)}
          onToggle={(checked) => onToggle([node.name], checked)}
        />
      )}
    </>
  );
}

const FLOWS: readonly { id: Flow; label: string }[] = [
  { id: "all", label: "Show all" },
  { id: "in", label: "Money in" },
  { id: "out", label: "Money out" },
];

function AmountMenu({
  header,
  view,
  onViewChange,
  currencies,
}: MenuProps & { currencies: readonly string[] }) {
  const sortName = useId();
  const flowName = useId();
  const sorted = sortedBy(view.sort, "amount");
  const sortBy = (direction: SortDirection) =>
    onViewChange({ ...view, sort: { column: "amount", direction } });
  const hidden = view.hiddenCurrencies;
  const hide = (hiddenCurrencies: ReadonlySet<string>) =>
    onViewChange({ ...view, hiddenCurrencies });

  return (
    <HeaderMenu
      {...header}
      column="amount"
      sorted={sorted}
      filtered={view.flow !== "all" || hidesAny(currencies, hidden)}
    >
      {/* By how large they are, whichever way the money went: the amounts show no minus. */}
      <MenuGroup title="Sort">
        <RadioItem
          name={sortName}
          label="Smallest first"
          checked={sorted === "ascending"}
          onPick={() => sortBy("ascending")}
        />
        <RadioItem
          name={sortName}
          label="Largest first"
          checked={sorted === "descending"}
          onPick={() => sortBy("descending")}
        />
      </MenuGroup>
      <MenuGroup title="Filter">
        {FLOWS.map(({ id, label }) => (
          <RadioItem
            key={id}
            name={flowName}
            label={label}
            checked={view.flow === id}
            onPick={() => onViewChange({ ...view, flow: id })}
          />
        ))}
      </MenuGroup>
      <MenuGroup title="Currency">
        <CheckAll label="All currencies" values={currencies} hidden={hidden} onHide={hide}>
          {currencies.map((currency) => (
            <CheckboxItem
              key={currency}
              label={currency}
              level={1}
              checked={!hidden.has(currency)}
              onToggle={(checked) => hide(toggled(hidden, [currency], checked))}
            />
          ))}
        </CheckAll>
      </MenuGroup>
    </HeaderMenu>
  );
}

function RemarksMenu({ header, view, onViewChange }: MenuProps) {
  return (
    <HeaderMenu
      {...header}
      column="remarks"
      sorted={sortedBy(view.sort, "remarks")}
      filtered={false}
    >
      <TextSort column="remarks" view={view} onViewChange={onViewChange} />
    </HeaderMenu>
  );
}
