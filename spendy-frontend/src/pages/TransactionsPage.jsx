import { useContext, useEffect, useState, useMemo, useRef } from "react";

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
  const [filterList, setFilterList] = useState(null);
  const navigate = useNavigate();
  const searchElemRef = useRef(null);

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

  /// Search
  let worker = useMemo(() => {
    return new Worker(new URL("../worker.js", import.meta.url), {
      type: "module",
    });
  }, []);
  useEffect(() => {
    const handler = (e) => {
      // TODO: Use debounce instead of setTimeout
      // TODO: Also debounce sending the search input to the worker
      setTimeout(() => {
        if (e.data.searchInput === searchElemRef.current?.value)
          setFilterList(e.data.filterList);
      }, 66);
    };
    worker.addEventListener("message", handler);
    return () => worker.removeEventListener("message", handler);
  }, [worker]);
  useEffect(() => {
    worker.postMessage({ transactions });
  }, [worker, transactions]);
  useEffect(() => {
    if (searchInput) worker.postMessage({ searchInput });
    else setFilterList(null);
  }, [worker, searchInput]);

  const totalSpending = useMemo(() => {
    const now = new Date();
    return (filterList || Object.keys(transactions))
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
              searchElemRef,
              setSearchInput,
              ephemeralMails,
              setEphemeralMails,
            }}
          />
        )}
        {viewport === "mobile" && (
          <TransactionFlex
            {...{
              transactions,
              filterList,
              searchInput,
              searchElemRef,
              setSearchInput,
            }}
          />
        )}
      </div>
    </div>
  );
}

export default TransactionsPage;
