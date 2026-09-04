import argparse
import json

from . import market, research, store
from .locking import WorkspaceLock


def main():
    parser = argparse.ArgumentParser(description="AlphaView local dashboard")
    parser.add_argument("command", choices=["seed", "refresh", "scan", "serve"])
    parser.add_argument("--port", type=int, default=8876)
    parser.add_argument("--scope", choices=["portfolio", "market"], default="portfolio")
    parser.add_argument("--universe-limit", type=int, choices=market.UNIVERSE_LIMITS, default=250,
                        help="Maximum candidates for market refresh (default: 250)")
    args = parser.parse_args()
    if args.universe_limit != 250 and (args.command != "refresh" or args.scope != "market"):
        parser.error("--universe-limit only applies to refresh --scope market")
    store.init_db()
    if args.command == "serve":
        import uvicorn
        uvicorn.run("alphaview.panel.api:app", host="127.0.0.1", port=args.port)
        return
    lock = WorkspaceLock()
    if not lock.acquire(blocking=False):
        parser.exit(1, "Another workspace writer is running; wait for it to finish.\n")
    try:
        if args.command == "seed":
            store.seed_portfolio()
            print("Starter watchlist added without overwriting existing positions.")
        elif args.command == "refresh":
            print(json.dumps(market.refresh(print, scope=args.scope, universe_limit=args.universe_limit), ensure_ascii=False, indent=2))
            print(json.dumps(research.scan(print, scope=args.scope), ensure_ascii=False))
        elif args.command == "scan":
            print(json.dumps(research.scan(print, scope=args.scope), ensure_ascii=False))
    finally:
        lock.release()



if __name__ == "__main__":
    main()
