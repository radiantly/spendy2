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
import TransactionFlex from "../components/TransactionFlex";

function TransactionsPage() {
  const [user] = useContext(UserContext);
  const [transactions, updateTransactions] = useImmer({});
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [ephemeralMails, setEphemeralMails] = useState([]);
  const [viewport, setViewport] = useState(null);
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

  const filterList = useMemo(() => {
    if (!searchInput) return Array.from(Object.keys(transactions));

    const matches = [];
    try {
      const re = new RegExp(searchInput, "im");

      for (const [id, transaction] of Object.entries(transactions))
        if (
          re.test(transaction.party) ||
          re.test(transaction.remarks) ||
          re.test(transaction.type) ||
          re.test(transaction.amount) ||
          re.test(transaction.currency)
        )
          matches.push(id);
    } catch {
      for (const [id, transaction] of Object.entries(transactions))
        if (
          transaction.party.includes(searchInput) ||
          transaction.remarks.includes(searchInput) ||
          transaction.type.includes(searchInput) ||
          transaction.amount.toString().includes(searchInput) ||
          transaction.currency.includes(searchInput)
        )
          matches.push(id);
    }
    return matches;
  }, [transactions, searchInput]);

  const totalSpending = useMemo(() => {
    const now = new Date();
    return filterList
      .filter(
        (id) =>
          !transactions[id].hidden &&
          transactions[id].date.getMonth() == now.getMonth() &&
          transactions[id].date.getFullYear() == now.getFullYear()
      )
      .reduce(
        (acc, id) =>
          acc + toINR(transactions[id].currency, transactions[id].amount),
        0
      );
  }, [transactions, filterList]);

  useEffect(() => {
    const updateViewport = () =>
      setViewport(
        window.matchMedia("screen and (max-width: 600px)").matches
          ? "mobile"
          : "desktop"
      );
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  return (
    <div className={bgContainer}>
      <div className={container}>
        {/* <Navbar /> */}
        <Dash {...{ totalSpending, searchInput }} />
        {loading || Object.keys(transactions).length ? null : <NoMailHere />}
        {viewport === "desktop" && (
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
        )}
        {viewport === "mobile" && (
          <TransactionFlex
            {...{ transactions, filterList, searchInput, setSearchInput }}
          />
        )}
      </div>
    </div>
  );
}

export default TransactionsPage;
