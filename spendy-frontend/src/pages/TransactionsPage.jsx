import { useContext, useEffect, useState } from "react";

import { bgContainer, container } from "../css/TransactionsPage.module.css";
import Navbar from "../components/Navbar";
import Dash from "../components/Dash";
import { useImmer } from "use-immer";
import TransactionGrid from "../components/TransactionGrid";
import { toINR } from "../currency";
import { UserContext } from "../contexts/UserContext";
import { parseAPITransaction } from "../utils";
import NoMailHere from "../components/NoMailHere";

function TransactionsPage() {
  const [user] = useContext(UserContext);

  const [transactions, updateTransactions] = useImmer({});
  const [filterList, setFilterList] = useState([]);
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [ephemeralMails, setEphemeralMails] = useState([]);

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
      setLoading(false);
    })();
  }, []);

  user.session.useWebSocket("/api/ws", async ({ data }) => {
    console.log(data);
    const obj = JSON.parse(data);

    // non transactional mail
    if (obj.raw) {
      setEphemeralMails([
        JSON.parse(await user.keypair.decrypt(obj.raw)),
        ...ephemeralMails,
      ]);
      return;
    }

    const transaction = await parseAPITransaction(obj, user.keypair);
    updateTransactions((trans) => {
      trans[transaction.id] = transaction;
    });
  });

  console.log("Loader data:", transactions);

  const totalSpending = filterList.reduce(
    (acc, id) =>
      acc +
      (transactions[id].hidden
        ? 0
        : toINR(transactions[id].currency, transactions[id].amount)),
    0
  );

  return (
    <div className={bgContainer}>
      <div className={container}>
        {/* <Navbar /> */}
        <Dash {...{ totalSpending, searchInput }} />
        {loading || Object.keys(transactions).length ? null : <NoMailHere />}
        <TransactionGrid
          {...{
            transactions,
            updateTransactions,
            filterList,
            setFilterList,
            searchInput,
            setSearchInput,
            ephemeralMails,
            setEphemeralMails,
          }}
        />
      </div>
    </div>
  );
}

export default TransactionsPage;
