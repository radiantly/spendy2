import {
  date,
  payee,
  mode,
  amount,
  remarks,
  row,
  moreActions,
  blurred,
  menuActive,
} from "../css/TransactionRow.module.css";
import { getCurrencyPrefix } from "../currency";
import { toNiceDateString } from "../utils";
import Menu from "./Menu";
import { AnimatePresence } from "framer-motion";
import { FaEllipsisH } from "react-icons/fa";
const TransactionRow = ({
  transaction,
  index,
  updateTransactions,
  activeMenuIdx,
  setActiveMenuIdx,
}) => {
  return (
    <div className={[row, transaction.hidden ? blurred : ""].join(" ")}>
      <div className={date} title={transaction.date.toLocaleString()}>
        {toNiceDateString(transaction.date)}
      </div>
      <div className={payee}>{transaction.party}</div>
      <div className={mode}>{transaction.type}</div>
      <div
        className={amount}
        data-currency-prefix={getCurrencyPrefix(transaction.currency)}
      >
        {transaction.amount}
      </div>
      <input
        className={remarks}
        value={transaction.remarks}
        onInput={(e) =>
          updateTransactions((t) => {
            t[index].remarks = e.target.value;
          })
        }
      />
      <div
        className={[
          moreActions,
          activeMenuIdx === index ? menuActive : "",
        ].join(" ")}
        onClick={(event) => {
          if (!event.target.dataset.action)
            return setActiveMenuIdx(activeMenuIdx === index ? null : index);
          if (event.target.dataset.action === "toggleVisibility")
            return updateTransactions((t) => {
              t[index].hidden = !t[index].hidden;
            });
        }}
      >
        <FaEllipsisH />
        <AnimatePresence>
          {activeMenuIdx === index ? (
            <Menu
              triggerHide={() => {
                console.log("triggered");
                setActiveMenuIdx(null);
              }}
              hidden={transaction.hidden}
            />
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default TransactionRow;
