"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, CreditCard } from "lucide-react";

export default function SubscriptionPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Subscription</h1>
        <p className="text-muted-foreground">Manage your subscription and billing</p>
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
              <span className="text-4xl font-bold">&euro;15</span>
              <span className="text-muted-foreground">/month</span>
            </div>
            <div className="space-y-2">
              <h4 className="font-semibold">Unlimited Plan</h4>
              <ul className="space-y-2 text-sm">
                {["Unlimited PDF conversions", "Any voice from YouTube", "Priority processing queue", "Advanced voice clipping tools"].map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <span>{item}</span>
                  </li>
                ))}
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
                &bull;&bull;&bull;&bull; 4242
              </span>
            </div>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1">Update Payment</Button>
            <Button variant="outline" className="flex-1 text-destructive hover:bg-destructive/10">Cancel Plan</Button>
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
              { date: "Dec 4, 2024", amount: "\u20AC15.00", status: "Paid" },
              { date: "Nov 4, 2024", amount: "\u20AC15.00", status: "Paid" },
              { date: "Oct 4, 2024", amount: "\u20AC15.00", status: "Paid" },
            ].map((invoice, index) => (
              <div key={index} className="flex items-center justify-between p-4 bg-muted/30 rounded-lg">
                <div>
                  <div className="font-medium">{invoice.date}</div>
                  <div className="text-sm text-muted-foreground">Monthly subscription</div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="font-medium">{invoice.amount}</div>
                    <Badge variant="outline" className="text-xs">{invoice.status}</Badge>
                  </div>
                  <Button size="sm" variant="outline">Invoice</Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Usage Stats */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>This Month&apos;s Usage</CardTitle>
          <CardDescription>Your conversion statistics</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { value: "12", label: "Audiobooks created" },
              { value: "847", label: "Pages processed" },
              { value: "4.2h", label: "Audio generated" },
              { value: "8", label: "Voices used" },
            ].map((stat) => (
              <div key={stat.label} className="space-y-1">
                <div className="text-2xl font-bold">{stat.value}</div>
                <div className="text-sm text-muted-foreground">{stat.label}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
