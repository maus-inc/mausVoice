import {
  Table as MuiTable,
  TableBody as MuiTableBody,
  TableFooter as MuiTableFooter,
  TableHead as MuiTableHead,
  TableRow as MuiTableRow,
  Paper,
  TableCell,
  TableContainer,
  TableSortLabel,
  type SxProps,
} from "@mui/material";
import * as React from "react";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";

export type DivRowProps = React.HTMLAttributes<HTMLDivElement> & {
  "data-index"?: number;
};

export interface ColumnDef<T> {
  header: React.ReactNode | (() => React.ReactNode);
  cell: (row: T) => React.ReactNode;
  getSortKey?: (row: T) => string | number;
  weight?: number;
  width?: number;
}

const DefaultRow = React.forwardRef<HTMLDivElement, DivRowProps>(
  (props, ref) => <MuiTableRow ref={ref} component="div" {...props} />,
);

export interface AppTableProps<T> {
  readonly rows: T[];
  readonly columns: ColumnDef<T>[];
  readonly sx?: SxProps;
  readonly RowComponent?: React.ForwardRefExoticComponent<
    React.PropsWithoutRef<DivRowProps> & React.RefAttributes<HTMLDivElement>
  >;
  readonly footer?: React.ReactNode;
  readonly defaultSortColumnIndex?: number;
  readonly defaultSortDirection?: SortDirection;
}

type SortDirection = "asc" | "desc";

const VirtuosoScroller = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>((props, ref) => <TableContainer component={Paper} ref={ref} {...props} />);

const VirtuosoTable = (props: React.HTMLAttributes<HTMLDivElement>) => (
  <MuiTable
    {...props}
    component="div"
    sx={{ borderCollapse: "separate", tableLayout: "fixed" }}
  />
);

const VirtuosoTableHead = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>((props, ref) => <MuiTableHead ref={ref} component="div" {...props} />);

const VirtuosoTableBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>((props, ref) => <MuiTableBody ref={ref} component="div" {...props} />);

const VirtuosoTableFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>((props, ref) => <MuiTableFooter ref={ref} component="div" {...props} />);

export function AppTable<T>({
  rows,
  columns,
  sx,
  RowComponent,
  footer,
  defaultSortColumnIndex,
  defaultSortDirection = "asc",
}: AppTableProps<T>) {
  const [sortIdx, setSortIdx] = React.useState<number | null>(
    defaultSortColumnIndex ?? null,
  );
  const [direction, setDirection] =
    React.useState<SortDirection>(defaultSortDirection);

  const handleHeaderClick = (idx: number) => {
    if (!columns[idx].getSortKey) return;
    if (sortIdx === idx) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortIdx(idx);
      setDirection("asc");
    }
  };

  const sortedRows = React.useMemo(() => {
    if (sortIdx === null) return rows;
    const sorter = columns[sortIdx].getSortKey;
    if (!sorter) return rows;
    return [...rows].sort((a, b) => {
      const aKey = sorter(a);
      const bKey = sorter(b);
      if (aKey < bKey) return direction === "asc" ? -1 : 1;
      if (aKey > bKey) return direction === "asc" ? 1 : -1;
      return 0;
    });
  }, [rows, sortIdx, direction, columns]);

  const fixedWidth = columns.reduce((sum, c) => sum + (c.width ?? 0), 0);
  const weightTotal = columns
    .filter((c) => c.width === undefined)
    .reduce((s, c) => s + (c.weight ?? 1), 0);

  const colWidths = columns.map((c) => {
    if (c.width !== undefined) return c.width;
    const ratio = (c.weight ?? 1) / weightTotal;
    return `calc((100% - ${fixedWidth}px) * ${ratio})`;
  });

  const columnKeys = React.useMemo(
    () => columns.map((_, idx) => `column-${idx}`),
    [columns],
  );

  const VirtuosoComponents: TableComponents<T> = React.useMemo(
    () => ({
      Scroller: VirtuosoScroller as any,
      Table: VirtuosoTable as any,
      TableHead: VirtuosoTableHead as any,
      TableBody: VirtuosoTableBody as any,
      TableRow: (RowComponent ?? DefaultRow) as any,
      TableFooter: VirtuosoTableFooter as any,
    }),
    [RowComponent],
  );

  const renderFixedHeader = () => (
    <MuiTableRow component="div">
      {columns.map((col, idx) => {
        const sortable = Boolean(col.getSortKey);
        const active = sortIdx === idx;
        const content =
          typeof col.header === "function" ? col.header() : col.header;
        return (
          <TableCell
            key={columnKeys[idx]}
            variant="head"
            component="div"
            sx={{
              width: colWidths[idx],
              cursor: sortable ? "pointer" : undefined,
              userSelect: "none",
              backgroundColor: "level1",
            }}
            onClick={() => handleHeaderClick(idx)}
          >
            {sortable ? (
              <TableSortLabel
                active={active}
                direction={active ? direction : "asc"}
              >
                {content}
              </TableSortLabel>
            ) : (
              content
            )}
          </TableCell>
        );
      })}
    </MuiTableRow>
  );

  const renderRow = (_: number, row: T) => (
    <>
      {columns.map((col, idx) => (
        <TableCell
          component="div"
          key={columnKeys[idx]}
          sx={{ width: colWidths[idx] }}
        >
          {col.cell(row)}
        </TableCell>
      ))}
    </>
  );

  const renderFixedFooter = () => footer;

  return (
    <Paper sx={sx}>
      <TableVirtuoso
        data={sortedRows}
        components={VirtuosoComponents}
        fixedHeaderContent={renderFixedHeader}
        itemContent={renderRow}
        fixedFooterContent={(footer ? renderFixedFooter : undefined) as any}
      />
    </Paper>
  );
}
