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
import { useCallback } from "react";
import { getCurrencyPrefix } from "../currency";
import { toNiceDateString } from "../utils";
import Menu from "./Menu";
import { AnimatePresence } from "framer-motion";
import { FaEllipsisH } from "react-icons/fa";
import { postJSON, encryptText, fromPem, debounce } from "../utils";
const TransactionRow = ({
  transaction,
  index,
  updateTransactions,
  activeMenuIdx,
  setActiveMenuIdx,
}) => {
  const savemodifiedRemarks = useCallback(
    debounce((e) => {
      const userString = localStorage.getItem("user");
      let user;
      try {
        user = JSON.parse(userString);
        if (!user?.username) throw false;
      } catch {
        console.log("Failed to get user from localstorage");
      }
      const keypair = fromPem(user.keypair);
      const newTransaction = { ...transaction };
      delete newTransaction.id;
      delete newTransaction.date;
      newTransaction.remarks = e.target.value;
      const encrypted = encryptText(
        keypair.publicKey,
        JSON.stringify(newTransaction)
      );
      postJSON("/api/transaction", {
        id: transaction.id,
        owner: user.username,
        date: transaction.date,
        encrypted,
      });
    }, 333),
    []
  );

  const modifyRemarks = (e) => {
    updateTransactions((t) => {
      t[index].remarks = e.target.value;
    });
    savemodifiedRemarks(e);
  };

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
        onInput={modifyRemarks}
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
