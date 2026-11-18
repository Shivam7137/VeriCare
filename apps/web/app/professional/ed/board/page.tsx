import type { Metadata } from "next";
import BoardView from "../../../../components/vc/board-view";

export const metadata: Metadata = { title: "Board" };

export default function Page() {
  return <BoardView />;
}
