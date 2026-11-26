import { useRef } from "react";
import { useFetcher } from "react-router";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

export function CancelAudit({ scope, id }: { scope: "report" | "run"; id: number }) {
  const fetcher = useFetcher();
  const keepRunning = useRef<HTMLButtonElement>(null);
  const pending = fetcher.state !== "idle";
  const label = `Cancel ${scope}`;
  return <Dialog>
    <DialogTrigger render={<Button variant="outline" size="sm" />} disabled={pending}>{label}</DialogTrigger>
    <DialogContent role="alertdialog" initialFocus={keepRunning} showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>{label} #{id}?</DialogTitle>
        <DialogDescription>{scope === "run"
          ? "All queued and running reports in this run will stop. Completed results stay available."
          : "This audit will stop. Other reports in this run will continue."}</DialogDescription>
      </DialogHeader>
      <fetcher.Form method="post">
        <DialogFooter>
          <DialogClose ref={keepRunning} render={<Button type="button" variant="outline" />} disabled={pending}>Keep running</DialogClose>
          <Button type="submit" name="intent" value="cancel" variant="destructive" disabled={pending}>
            {pending ? "Canceling…" : label}
          </Button>
        </DialogFooter>
      </fetcher.Form>
    </DialogContent>
  </Dialog>;
}
