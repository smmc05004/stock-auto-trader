import { MockBrokerClient } from "@/lib/broker/mockBroker";
import { env } from "@/lib/config/env";

export function createBrokerClient() {
  switch (env.BROKER_PROVIDER) {
    case "mock":
      return new MockBrokerClient();
  }
}
