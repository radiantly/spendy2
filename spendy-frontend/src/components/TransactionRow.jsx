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
import { useCallback, useContext, useEffect } from "react";
import { getCurrencyPrefix } from "../currency";
import { Keypair, toNiceDateString } from "../utils";
import Menu from "./Menu";
import { AnimatePresence } from "framer-motion";
import { FaEllipsisH } from "react-icons/fa";
import { debounce } from "../utils";
import { UserContext } from "../contexts/UserContext";
import { useImmer } from "use-immer";
const TransactionRow = ({
  transactions,
  id,
  activeMenuId,
  setActiveMenuId,
  updateTransactions,
}) => {
  const [user] = useContext(UserContext);
  const [transaction, updateTransaction] = useImmer({ ...transactions[id] });
  const saveModifications = useCallback(
    debounce(async (trans) => {
      const newTransaction = { ...trans };

      // these properties are not encrypted
      delete newTransaction.id;
      delete newTransaction.date;
      delete newTransaction.owner;

      const encrypted = await user.keypair.encrypt(
        JSON.stringify(newTransaction)
      );
      console.log("Saving", newTransaction);
      user.session.post("/api/transaction", {
        id: trans.id,
        owner: user.username,
        date: trans.date,
        encrypted,
      });
    }, 333),
    []
  );
  useEffect(() => {
    // Ignore if nothing has changed
    if (
      +transactions[id].date === +transaction.date &&
      transactions[id].hidden === transaction.hidden &&
      transactions[id].remarks === transaction.remarks
    )
      return;

    saveModifications(transaction);
    updateTransactions((trans) => {
      trans[id] = { ...transaction };
    });
  }, [transaction]);

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
          updateTransaction((t) => {
            t.remarks = e.target.value;
          })
        }
      />
      <div
        className={[moreActions, activeMenuId === id ? menuActive : ""].join(
          " "
        )}
        onClick={(event) => {
          if (!event.target.dataset.action)
            return setActiveMenuId(activeMenuId === id ? null : id);
          if (event.target.dataset.action === "toggleVisibility")
            return updateTransaction((t) => {
              t.hidden = !t.hidden;
            });
        }}
      >
        <FaEllipsisH />
        <AnimatePresence>
          {activeMenuId === id ? (
            <Menu
              triggerHide={() => {
                console.log("triggered");
                setActiveMenuId(null);
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
