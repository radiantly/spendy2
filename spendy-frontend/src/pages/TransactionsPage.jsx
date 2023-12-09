import { useContext, useEffect, useState } from "react";

import { bgContainer, container } from "../css/TransactionsPage.module.css";
import Navbar from "../components/Navbar";
import Dash from "../components/Dash";
import { useImmer } from "use-immer";
import TransactionGrid from "../components/TransactionGrid";
import { toINR } from "../currency";
import { UserContext } from "../contexts/UserContext";
import { parseAPITransaction } from "../utils";

function TransactionsPage() {
  const [user] = useContext(UserContext);

  const [transactions, updateTransactions] = useImmer({});
  const [filterList, setFilterList] = useState([]);
  const [searchInput, setSearchInput] = useState("");

  useEffect(() => {
    (async () => {
      const response = await user.session.post("/api/transactions");

      if (response.status !== 200) return console.log("fail", response);
      const apiTransactions = await response.json();

      const parsedTransactions = await Promise.all(
        apiTransactions.map((t) => parseAPITransaction(t, user.keypair))
      );

      updateTransactions((trans) => {
        for (const transaction of parsedTransactions)
          trans[transaction.id] = transaction;
      });
    })();
  }, []);

  user.session.useWebSocket("/api/ws", async ({ data }) => {
    console.log(data);
    const transaction = await parseAPITransaction(
      JSON.parse(data),
      user.keypair
    );
    updateTransactions((trans) => {
      trans[transaction.id] = transaction;
    });
  });

  console.log("Loader data:", transactions);

  const totalSpending = Object.values(transactions).reduce(
    (acc, transaction) =>
      acc +
      (transaction.hidden
        ? 0
        : toINR(transaction.currency, transaction.amount)),
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
