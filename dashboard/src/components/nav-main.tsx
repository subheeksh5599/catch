"use client"

import { ChevronRight, type LucideIcon } from "lucide-react"
import { Link, useLocation } from "react-router-dom"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

export function NavMain({
  label,
  items,
}: {
  label: string
  items: {
    title: string
    url: string
    icon?: LucideIcon
    isActive?: boolean
    items?: {
      title: string
      url: string
      isActive?: boolean
    }[]
  }[]
}) {
  const location = useLocation()

  // Check if any subitem is active to determine if parent should be open
  const shouldBeOpen = (item: (typeof items)[0]) => {
    if (item.isActive) return true
    return (
      item.items?.some((subItem) => location.pathname === subItem.url) || false
    )
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <Collapsible
            key={item.title}
            defaultOpen={shouldBeOpen(item)}
            className="group/collapsible"
            render={<SidebarMenuItem />}
          >
            {item.items?.length ? (
              <>
                <CollapsibleTrigger
                  render={
                    <SidebarMenuButton
                      tooltip={item.title}
                      className="cursor-pointer"
                    />
                  }
                >
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                  <ChevronRight className="ml-auto transition-transform duration-200 group-data-open/collapsible:rotate-90" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {item.items?.map((subItem) => (
                      <SidebarMenuSubItem key={subItem.title}>
                        <SidebarMenuSubButton
                          className="cursor-pointer"
                          isActive={location.pathname === subItem.url}
                          render={
                            <Link
                              to={subItem.url}
                              target={
                                item.title === "Auth Pages" ||
                                item.title === "Errors"
                                  ? "_blank"
                                  : undefined
                              }
                              rel={
                                item.title === "Auth Pages" ||
                                item.title === "Errors"
                                  ? "noopener noreferrer"
                                  : undefined
                              }
                            />
                          }
                        >
                          <span>{subItem.title}</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </>
            ) : (
              <SidebarMenuButton
                tooltip={item.title}
                className="cursor-pointer"
                isActive={location.pathname === item.url}
                render={<Link to={item.url} />}
              >
                {item.icon && <item.icon />}
                <span>{item.title}</span>
              </SidebarMenuButton>
            )}
          </Collapsible>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
