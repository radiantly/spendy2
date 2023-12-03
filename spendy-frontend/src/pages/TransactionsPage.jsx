import { useEffect, useState } from "react";

import { bgContainer, container } from "../css/TransactionsPage.module.css";
import { useLoaderData } from "react-router-dom";
import Navbar from "../components/Navbar";
import Dash from "../components/Dash";
import { useImmer } from "use-immer";
import TransactionGrid from "../components/TransactionGrid";
import { toINR } from "../currency";

function TransactionsPage() {
  const loadedTransactions = useLoaderData();
  const [transactions, updateTransactions] = useImmer([]);
  const [filterList, setFilterList] = useState([]);
  const [searchInput, setSearchInput] = useState("");

  useEffect(() => updateTransactions(loadedTransactions), [loadedTransactions]);

  console.log("Loader data:", transactions);

  const totalSpending = filterList.reduce(
    (acc, index) =>
      acc +
      (transactions[index].hidden
        ? 0
        : toINR(transactions[index].currency, transactions[index].amount)),
    0
  );

  return (
    <div className={bgContainer}>
      <div className={container}>
        {/* <Navbar /> */}
        <Dash {...{ totalSpending, searchInput }} />
        <TransactionGrid
          {...{
            transactions,
            updateTransactions,
            filterList,
            setFilterList,
            searchInput,
            setSearchInput,
          }}
        />
      </div>
    </div>
  );
}

export default TransactionsPage;
