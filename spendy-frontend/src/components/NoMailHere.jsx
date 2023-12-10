import { LuMailbox } from "react-icons/lu";
import { container } from "../css/Dash.module.css";
import { parent, mailbox, title, para } from "../css/NoMailHere.module.css";
import { useContext } from "react";
import { UserContext } from "../contexts/UserContext";
const NoMailHere = () => {
  const [user] = useContext(UserContext);
  return (
    <div className={[container, parent].join(" ")}>
      <div className={mailbox}>
        <LuMailbox />
      </div>
      <div className={title}>No mail here yet!</div>
      <div className={para}>
        <div>
          Set up a forwarding rule in your email inbox that forwards
          transactional emails to {user.username}@spendy.arunjoshua.com
        </div>
        <div>
          Note: If you require a code to confirm your forwarding address (for
          example, in Gmail), keep this page open.
        </div>
      </div>
    </div>
  );
};

export default NoMailHere;
