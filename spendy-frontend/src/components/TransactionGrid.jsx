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
const TransactionGrid = ({
  transactions,
  updateTransactions,
  filterList,
  setFilterList,
  searchInput,
  setSearchInput,
}) => {
  const [activeMenuIdx, setActiveMenuIdx] = useState(null);
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
        <div className={date}>date</div>
        <div className={payee}>payee</div>
        <div className={mode}>mode</div>
        <div className={amount}>amount</div>
        <div className={remarks}>remarks</div>
        <div className={moreActions}></div>
      </div>

      {filterList.map((index) => (
        <TransactionRow
          key={transactions[index].id}
          transaction={transactions[index]}
          {...{ index, activeMenuIdx, setActiveMenuIdx, updateTransactions }}
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
