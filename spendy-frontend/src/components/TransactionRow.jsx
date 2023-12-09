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
const TransactionRow = ({
  transaction,
  index,
  updateTransactions,
  activeMenuIdx,
  setActiveMenuIdx,
}) => {
  const [user] = useContext(UserContext);
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
    saveModifications(transaction);
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
