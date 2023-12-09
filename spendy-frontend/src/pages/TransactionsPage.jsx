import { useContext, useEffect, useState } from "react";

import { bgContainer, container } from "../css/TransactionsPage.module.css";
import Navbar from "../components/Navbar";
import Dash from "../components/Dash";
import { useImmer } from "use-immer";
import TransactionGrid from "../components/TransactionGrid";
import { toINR } from "../currency";
import { UserContext } from "../contexts/UserContext";
import { Navigate } from "react-router-dom";

function TransactionsPage() {
  const [user] = useContext(UserContext);

  const [transactions, updateTransactions] = useImmer([]);
  const [filterList, setFilterList] = useState([]);
  const [searchInput, setSearchInput] = useState("");

  useEffect(() => {
    (async () => {
      const response = await user.session.post("/api/transactions");

      if (response.status !== 200) return console.log("fail", response);
      const transactionJson = await response.json();

      updateTransactions(
        await Promise.all(
          transactionJson.map(async ({ id, date, encrypted }) => {
            const transaction = {
              id,
              date: new Date(date),
              remarks: "",
              hidden: false,
              ...JSON.parse(await user.keypair.decrypt(encrypted)),
            };

            if (!transaction.remarks && transaction.labels)
              transaction.remarks = transaction.labels.join(" ");

            return transaction;
          })
        )
      );
    })();
  }, []);

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
