import { useMemo } from "react";
import {
  wrap,
  dateHeader,
  tile,
  infoCol,
  priceCol,
  party,
  transGroup,
  whatTime,
  mobileSearch,
} from "../css/TransactionFlex.module.css";
import { fromDateHash, toDateHash, toNiceDateString, tsorts } from "../utils";
import { getCurrencyPrefix } from "../currency";
import Search from "./Search";

const TransactionFlex = ({
  transactions,
  filterList,
  searchInput,
  setSearchInput,
}) => {
  const viewList = useMemo(
    () => filterList.map((id) => transactions[id]).sort(tsorts.dateDesc),
    [filterList]
  );

  const groupedTransactions = useMemo(() => {
    const datemap = new Map();
    for (const transaction of viewList) {
      const key = toDateHash(transaction.date);
      if (!datemap.has(key)) datemap.set(key, []);
      datemap.get(key).push(transaction);
    }

    return Array.from(datemap.entries());
  }, [viewList]);

  return (
    <div className={wrap}>
      <div className={mobileSearch}>
        <Search placeholder="Search..." {...{ searchInput, setSearchInput }} />
      </div>
      {groupedTransactions.map(([dateH, trans]) => (
        <div className={transGroup} key={dateH}>
          <div className={dateHeader}>
            {toNiceDateString(fromDateHash(dateH), false)}
          </div>
          {trans.map((t) => (
            <div key={t.id} className={tile}>
              <div className={infoCol}>
                <div className={party}>{t.party}</div>
                <div>
                  <div className={whatTime}>
                    {t.date
                      .toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })
                      .replace(" ", "")
                      .toLowerCase()}
                  </div>
                  {t.remarks}
                </div>
              </div>
              <div
                className={priceCol}
                data-currency-prefix={getCurrencyPrefix(t.currency)}
              >
                {t.amount}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

export default TransactionFlex;
