import { useMemo } from "react";
import {
  wrap,
  dateHeader,
  tile,
  infoCol,
  priceCol,
  party,
} from "../css/TransactionFlex.module.css";
import { fromDateHash, toDateHash, toNiceDateString } from "../utils";
import { getCurrencyPrefix } from "../currency";

const TransactionFlex = ({ transactions }) => {
  const groupedTransactions = useMemo(() => {
    const datemap = new Map();
    for (const transaction of Object.values(transactions)) {
      const key = toDateHash(transaction.date);
      if (!datemap.has(key)) datemap.set(key, []);
      datemap.get(key).push(transaction);
    }
    const datemapAr = Array.from(datemap.entries());
    datemapAr.sort().reverse();
    return datemapAr;
  }, [transactions]);

  return (
    <div className={wrap}>
      {groupedTransactions.map(([dateH, trans]) => (
        <>
          <div className={dateHeader}>
            {toNiceDateString(fromDateHash(dateH))}
          </div>
          {trans.map((t) => (
            <div key={t.id} className={tile}>
              <div className={infoCol}>
                <div className={party}>{t.party}</div>
                <div>{t.remarks}</div>
              </div>
              <div
                className={priceCol}
                data-currency-prefix={getCurrencyPrefix(t.currency)}
              >
                {t.amount}
              </div>
            </div>
          ))}
        </>
      ))}
    </div>
  );
};

export default TransactionFlex;
