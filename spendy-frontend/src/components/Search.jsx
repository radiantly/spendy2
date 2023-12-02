import { useEffect, useMemo, useRef } from "react";
import Fuse from "fuse.js";

const Search = ({
  searchInput,
  setSearchInput,
  transactions,
  setFilterList,
}) => {
  const searchElem = useRef(null);

  const fuse = useMemo(
    () =>
      new Fuse(transactions, {
        keys: ["party", "remarks"],
      }),
    [transactions]
  );

  useEffect(
    () =>
      setFilterList(
        searchInput
          ? fuse.search(searchInput).map((result) => result.refIndex)
          : [...Array(transactions.length).keys()]
      ),
    [searchInput, transactions]
  );

  useEffect(() => {
    const handler = (e) => {
      if (document.activeElement === document.body) searchElem.current.focus();
    };
    document.body.addEventListener("keydown", handler);
    return () => document.body.removeEventListener("keydown", handler);
  });

  return (
    <input
      ref={searchElem}
      value={searchInput}
      onInput={(e) => setSearchInput(e.target.value)}
    />
  );
};

export default Search;
