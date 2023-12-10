import { useContext, useEffect, useState, useMemo } from "react";

import { bgContainer, container } from "../css/TransactionsPage.module.css";
import Navbar from "../components/Navbar";
import Dash from "../components/Dash";
import { useImmer } from "use-immer";
import TransactionGrid from "../components/TransactionGrid";
import { toINR } from "../currency";
import { UserContext } from "../contexts/UserContext";
import { parseAPITransaction } from "../utils";
import NoMailHere from "../components/NoMailHere";
import { useNavigate } from "react-router-dom";
import Fuse from "fuse.js";

function TransactionsPage() {
  const [user] = useContext(UserContext);
  const [transactions, updateTransactions] = useImmer({});
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [ephemeralMails, setEphemeralMails] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      const response = await user.session.post("/api/transactions");

      if (response.status === 401)
        return navigate("/login", {
          state: {
            feedback: "You are signed out, please login.",
          },
        });

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

  const fuse = useMemo(
    () =>
      new Fuse(Array.from(Object.values(transactions)), {
        keys: ["party", "remarks"],
      }),
    [transactions]
  );

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

  const filterList = useMemo(
    () =>
      searchInput
        ? fuse.search(searchInput).map(({ item }) => item.id)
        : Array.from(Object.keys(transactions)),
    [transactions, searchInput]
  );

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
