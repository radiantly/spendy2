import {
  tgrid,
  contentDivider,
  headerDivider,
  searchBar,
} from "../css/TransactionGrid.module.css";

import {
  header,
  date,
  payee,
  mode,
  amount,
  remarks,
  row,
  moreActions,
} from "../css/TransactionRow.module.css";
import { FaSearch } from "react-icons/fa";
import Search from "./Search";
import { Fragment, useState } from "react";
import TransactionRow from "./TransactionRow";

const sorts = {
  dateAsc: (a, b) => a.date - b.date,
  dateDesc: (a, b) => b.date - a.date,
  partyAsc: (a, b) => a.party.localeCompare(b.party),
  partyDesc: (a, b) => b.party.localeCompare(a.party),
  typeAsc: (a, b) => a.type.localeCompare(b.type),
  typeDesc: (a, b) => b.type.localeCompare(a.type),
  amountAsc: (a, b) => a.amount - b.amount,
  amountDesc: (a, b) => b.amount - a.amount,
  remarksAsc: (a, b) => a.remarks.localeCompare(b.remarks),
  remarksDesc: (a, b) => b.remarks.localeCompare(a.remarks),
};

const TransactionGrid = ({
  transactions,
  updateTransactions,
  filterList,
  setFilterList,
  searchInput,
  setSearchInput,
}) => {
  const [activeMenuId, setActiveMenuId] = useState(null);
  const [sortOrder, setSortOrder] = useState("dateAsc");

  const changeSort = (col) => {
    if (!sortOrder?.startsWith(col)) return setSortOrder(`${col}Asc`);
    if (sortOrder === `${col}Asc`) return setSortOrder(`${col}Desc`);
    return setSortOrder(null);
  };

  const viewList = filterList.map((id) => transactions[id]);
  if (sortOrder) viewList.sort(sorts[sortOrder]);

  return (
    <div
      className={[tgrid, searchInput ? "search-active" : ""].join(" ")}
      style={{ gridTemplateRows: `repeat(${filterList.length + 1}, 40px)` }}
    >
      <label className={searchBar}>
        <FaSearch />
        <Search
          searchInput={searchInput}
          setSearchInput={setSearchInput}
          transactions={transactions}
          setFilterList={setFilterList}
        />
      </label>

      <div className={[header, row].join(" ")}>
        <div className={date} onClick={() => changeSort("date")}>
          date
        </div>
        <div className={payee} onClick={() => changeSort("party")}>
          payee
        </div>
        <div className={mode} onClick={() => changeSort("type")}>
          mode
        </div>
        <div className={amount} onClick={() => changeSort("amount")}>
          amount
        </div>
        <div className={remarks} onClick={() => changeSort("remarks")}>
          remarks
        </div>
        <div className={moreActions}></div>
      </div>

      {viewList.map(({ id }) => (
        <TransactionRow
          key={id}
          {...{
            transactions,
            id,
            activeMenuId,
            setActiveMenuId,
            updateTransactions,
          }}
        />
      ))}

      {[...Array(4).keys()].map((i) => (
        <Fragment key={i}>
          <div
            className={headerDivider}
            style={{
              gridColumnStart: (i + 1) * 2,
            }}
          ></div>
          <div
            className={contentDivider}
            style={{ gridColumnStart: (i + 1) * 2 }}
          ></div>
        </Fragment>
      ))}
    </div>
  );
};

export default TransactionGrid;
