import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Check, CreditCard } from "lucide-react";

export function SubscriptionPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="space-y-2">
        <h1>Subscription</h1>
        <p className="text-muted-foreground">
          Manage your subscription and billing
        </p>
      </div>

      {/* Current Plan */}
      <Card className="bg-card border-primary glow-purple">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <CardTitle>Current Plan</CardTitle>
              <CardDescription>Your active subscription</CardDescription>
            </div>
            <Badge className="bg-primary text-primary-foreground">Active</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-bold">€15</span>
              <span className="text-muted-foreground">/month</span>
            </div>
            <div className="space-y-2">
              <h4>Unlimited Plan</h4>
              <ul className="space-y-2 text-sm">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <span>Unlimited PDF conversions</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <span>Any voice from YouTube</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <span>Priority processing queue</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <span>Advanced voice clipping tools</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="pt-4 border-t border-border space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Next billing date:</span>
              <span>January 4, 2025</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Payment method:</span>
              <span className="flex items-center gap-2">
                <CreditCard className="w-4 h-4" />
                •••• 4242
              </span>
            </div>
          </div>

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1">
              Update Payment
            </Button>
            <Button variant="outline" className="flex-1 text-destructive hover:bg-destructive/10">
              Cancel Plan
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Billing History */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>Billing History</CardTitle>
          <CardDescription>Your past invoices and payments</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { date: "Dec 4, 2024", amount: "€15.00", status: "Paid" },
              { date: "Nov 4, 2024", amount: "€15.00", status: "Paid" },
              { date: "Oct 4, 2024", amount: "€15.00", status: "Paid" },
            ].map((invoice, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-4 bg-muted/30 rounded-lg"
              >
                <div className="flex items-center gap-4">
                  <div>
                    <div className="font-medium">{invoice.date}</div>
                    <div className="text-sm text-muted-foreground">Monthly subscription</div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="font-medium">{invoice.amount}</div>
                    <Badge variant="outline" className="text-xs">
                      {invoice.status}
                    </Badge>
                  </div>
                  <Button size="sm" variant="outline">
                    Invoice
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Usage Stats */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>This Month's Usage</CardTitle>
          <CardDescription>Your conversion statistics</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1">
              <div className="text-2xl font-bold">12</div>
              <div className="text-sm text-muted-foreground">Audiobooks created</div>
            </div>
            <div className="space-y-1">
              <div className="text-2xl font-bold">847</div>
              <div className="text-sm text-muted-foreground">Pages processed</div>
            </div>
            <div className="space-y-1">
              <div className="text-2xl font-bold">4.2h</div>
              <div className="text-sm text-muted-foreground">Audio generated</div>
            </div>
            <div className="space-y-1">
              <div className="text-2xl font-bold">8</div>
              <div className="text-sm text-muted-foreground">Voices used</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
