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
import GridHeader from "./GridHeader";
import EphemeralMails from "./EphemeralMails";
import { tsorts } from "../utils";

const TransactionGrid = ({
  transactions,
  updateTransactions,
  filterList,
  searchInput,
  setSearchInput,
  ephemeralMails,
  setEphemeralMails,
}) => {
  const [activeMenuId, setActiveMenuId] = useState(null);
  const [sortOrder, setSortOrder] = useState("dateDesc");
  const viewList = filterList.map((id) => transactions[id]);
  if (sortOrder) viewList.sort(tsorts[sortOrder]);

  return (
    <div
      className={[tgrid, searchInput ? "search-active" : ""].join(" ")}
      style={{
        gridTemplateRows: `repeat(${
          1 + ephemeralMails.length + filterList.length
        }, 40px)`,
      }}
    >
      <label className={searchBar}>
        <FaSearch />
        <Search searchInput={searchInput} setSearchInput={setSearchInput} />
      </label>

      <div className={[header, row].join(" ")}>
        <GridHeader
          className={date}
          sortKey="date"
          {...{ sortOrder, setSortOrder }}
        >
          date
        </GridHeader>
        <GridHeader
          className={payee}
          sortKey="party"
          {...{ sortOrder, setSortOrder }}
        >
          payee
        </GridHeader>
        <GridHeader
          className={mode}
          sortKey="type"
          {...{ sortOrder, setSortOrder }}
        >
          mode
        </GridHeader>
        <GridHeader
          className={amount}
          sortKey="amount"
          {...{ sortOrder, setSortOrder }}
        >
          amount
        </GridHeader>
        <GridHeader
          className={remarks}
          sortKey="remarks"
          {...{ sortOrder, setSortOrder }}
        >
          remarks
        </GridHeader>
        <div className={moreActions}></div>
      </div>

      <EphemeralMails {...{ ephemeralMails, setEphemeralMails }} />

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
