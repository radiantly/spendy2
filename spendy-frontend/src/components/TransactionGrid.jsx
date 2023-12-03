import {
  tgrid,
  header,
  date,
  payee,
  mode,
  amount,
  remarks,
  row,
  moreActions,
  contentDivider,
  headerDivider,
  searchBar,
  searchActive,
  menuActive,
  blurred,
} from "../css/TransactionGrid.module.css";
import { getCurrencyPrefix } from "../currency";
import { toNiceDateString } from "../utils";
import { FaSearch } from "react-icons/fa";
import { FaEllipsisH } from "react-icons/fa";
import Search from "./Search";
import { Fragment, useState } from "react";
import Menu from "./Menu";
import { AnimatePresence } from "framer-motion";
const TransactionGrid = ({ transactions, updateTransactions }) => {
  const [searchInput, setSearchInput] = useState("");
  const [filterList, setFilterList] = useState([]);
  const [activeMenuIdx, setActiveMenuIdx] = useState(null);
  return (
    <div
      className={[tgrid, searchInput ? searchActive : ""].join(" ")}
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

      {filterList.map((i) => (
        <div
          className={[row, transactions[i].hidden ? blurred : ""].join(" ")}
          key={transactions[i].id}
        >
          <div className={date} title={transactions[i].date.toLocaleString()}>
            {toNiceDateString(transactions[i].date)}
          </div>
          <div className={payee}>{transactions[i].party}</div>
          <div className={mode}>{transactions[i].type}</div>
          <div
            className={amount}
            data-currency-prefix={getCurrencyPrefix(transactions[i].currency)}
          >
            {transactions[i].amount}
          </div>
          <input
            className={remarks}
            value={transactions[i].remarks}
            onInput={(e) =>
              updateTransactions((t) => {
                t[i].remarks = e.target.value;
              })
            }
          />
          <div
            className={[
              moreActions,
              activeMenuIdx === i ? menuActive : "",
            ].join(" ")}
            onClick={(event) => {
              if (!event.target.dataset.action)
                return setActiveMenuIdx(activeMenuIdx === i ? null : i);
              if (event.target.dataset.action === "toggleVisibility")
                return updateTransactions((t) => {
                  t[i].hidden = !t[i].hidden;
                });
            }}
          >
            <FaEllipsisH />
            <AnimatePresence>
              {activeMenuIdx === i ? (
                <Menu
                  triggerHide={() => {
                    console.log("triggered");
                    setActiveMenuIdx(null);
                  }}
                  hidden={transactions[i].hidden}
                />
              ) : null}
            </AnimatePresence>
          </div>
        </div>
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
