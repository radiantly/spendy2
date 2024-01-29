import { useEffect } from "react";

const Search = ({ searchInput, setSearchInput, searchElemRef, ...props }) => {
  useEffect(() => {
    const handler = (event) => {
      if (event.ctrlKey) return;
      if (document.activeElement === document.body)
        searchElemRef.current.focus();
    };
    document.body.addEventListener("keydown", handler);
    return () => document.body.removeEventListener("keydown", handler);
  });

  return (
    <input
      {...{ ...props }}
      ref={searchElemRef}
      value={searchInput}
      onInput={(e) => setSearchInput(e.target.value)}
    />
  );
};

export default Search;
