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
} from "../css/TransactionGrid.module.css";
import { getCurrencyPrefix } from "../currency";
import { toNiceDateString } from "../utils";
import { VscEllipsis } from "react-icons/vsc";
const TransactionGrid = ({ transactions, updateTransactions }) => {
  return (
    <div
      className={tgrid}
      style={{ gridTemplateRows: `repeat(${transactions.length + 1}, 40px)` }}
    >
      <div className={[header, row].join(" ")}>
        <div className={date}>date</div>
        <div className={payee}>payee</div>
        <div className={mode}>mode</div>
        <div className={amount}>amount</div>
        <div className={remarks}>remarks</div>
        <div className={moreActions}></div>
      </div>

      {transactions.map((transaction, index) => (
        <div className={row} key={transaction.id}>
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
          <div className={moreActions}>
            <VscEllipsis />
          </div>
        </div>
      ))}

      {[...Array(4).keys()].map((i) => (
        <>
          <div
            className={headerDivider}
            style={{
              gridColumnStart: (i + 1) * 2,
            }}
          ></div>
          <div
            key={i}
            className={contentDivider}
            style={{ gridColumnStart: (i + 1) * 2 }}
          ></div>
        </>
      ))}
    </div>
  );
};

export default TransactionGrid;
