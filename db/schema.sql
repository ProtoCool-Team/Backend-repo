-- Schema bazei de date rrm_db (doar structura, fără date).
-- Exportată cu pg_dump --schema-only din backup-ul echipei (PostgreSQL 17).
-- Creare:  createdb -U postgres rrm_db
--          psql -U postgres -d rrm_db -f db/schema.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.12
-- Dumped by pg_dump version 17.12

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: fn_check_administrator_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_check_administrator_role() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (SELECT role FROM users WHERE user_id = NEW.administrator_id) <> 'ADMINISTRATOR' THEN
        RAISE EXCEPTION 'Utilizatorul % nu are rolul ADMINISTRATOR', NEW.administrator_id;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_check_researcher_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_check_researcher_role() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (SELECT role FROM users WHERE user_id = NEW.researcher_id) <> 'RESEARCHER' THEN
        RAISE EXCEPTION 'Utilizatorul % nu are rolul RESEARCHER', NEW.researcher_id;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: is_resource_free(uuid, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_resource_free(p_resource uuid, p_start timestamp with time zone, p_end timestamp with time zone) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT NOT EXISTS (
        SELECT 1
        FROM reservations r
        WHERE r.resource_id = p_resource
          AND r.status IN ('PENDING', 'APPROVED', 'ACTIVE')
          AND tstzrange(r.start_time, r.end_time, '[)') && tstzrange(p_start, p_end, '[)')
    );
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: approval_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_decisions (
    decision_id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    administrator_id uuid NOT NULL,
    decision character varying(20) NOT NULL,
    reason character varying(500),
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_decisions_check CHECK ((((decision)::text = 'APPROVED'::text) OR (reason IS NOT NULL))),
    CONSTRAINT approval_decisions_decision_check CHECK (((decision)::text = ANY (ARRAY[('APPROVED'::character varying)::text, ('REJECTED'::character varying)::text])))
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    audit_id uuid DEFAULT gen_random_uuid() NOT NULL,
    administrator_id uuid NOT NULL,
    action character varying(50) NOT NULL,
    entity_type character varying(50) NOT NULL,
    entity_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: availability_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.availability_windows (
    window_id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource_id uuid NOT NULL,
    day_of_week character varying(10) NOT NULL,
    open_time time without time zone NOT NULL,
    close_time time without time zone NOT NULL,
    CONSTRAINT availability_windows_check CHECK ((close_time > open_time)),
    CONSTRAINT availability_windows_day_of_week_check CHECK (((day_of_week)::text = ANY (ARRAY[('MONDAY'::character varying)::text, ('TUESDAY'::character varying)::text, ('WEDNESDAY'::character varying)::text, ('THURSDAY'::character varying)::text, ('FRIDAY'::character varying)::text, ('SATURDAY'::character varying)::text, ('SUNDAY'::character varying)::text])))
);


--
-- Name: locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.locations (
    location_id uuid DEFAULT gen_random_uuid() NOT NULL,
    building character varying(50) NOT NULL,
    room character varying(50) NOT NULL,
    floor integer NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    notification_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    reservation_id uuid,
    type character varying(20) NOT NULL,
    message character varying(500) NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT notifications_type_check CHECK (((type)::text = ANY (ARRAY[('NEW_REQUEST'::character varying)::text, ('APPROVED'::character varying)::text, ('REJECTED'::character varying)::text, ('CANCELLED'::character varying)::text, ('REMINDER'::character varying)::text])))
);


--
-- Name: reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservations (
    reservation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource_id uuid NOT NULL,
    researcher_id uuid NOT NULL,
    start_time timestamp with time zone NOT NULL,
    end_time timestamp with time zone NOT NULL,
    purpose character varying(500) NOT NULL,
    status character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reservations_check CHECK ((end_time > start_time)),
    CONSTRAINT reservations_status_check CHECK (((status)::text = ANY (ARRAY[('DRAFT'::character varying)::text, ('PENDING'::character varying)::text, ('APPROVED'::character varying)::text, ('REJECTED'::character varying)::text, ('CANCELLED'::character varying)::text, ('ACTIVE'::character varying)::text, ('COMPLETED'::character varying)::text, ('EXPIRED'::character varying)::text])))
);


--
-- Name: resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resources (
    resource_id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(150) NOT NULL,
    description text,
    type character varying(30) NOT NULL,
    status character varying(20) DEFAULT 'AVAILABLE'::character varying NOT NULL,
    location_id uuid NOT NULL,
    responsible_admin_id uuid,
    requires_approval boolean DEFAULT true NOT NULL,
    max_consecutive_hours integer,
    max_advance_days integer,
    min_cancel_notice_hours integer,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resources_max_advance_days_check CHECK ((max_advance_days > 0)),
    CONSTRAINT resources_max_consecutive_hours_check CHECK ((max_consecutive_hours > 0)),
    CONSTRAINT resources_min_cancel_notice_hours_check CHECK ((min_cancel_notice_hours >= 0)),
    CONSTRAINT resources_status_check CHECK (((status)::text = ANY (ARRAY[('AVAILABLE'::character varying)::text, ('UNAVAILABLE'::character varying)::text]))),
    CONSTRAINT resources_type_check CHECK (((type)::text = ANY (ARRAY[('ROBOT'::character varying)::text, ('MEASURING_DEVICE'::character varying)::text, ('COMPUTE_CLUSTER'::character varying)::text, ('LAB_ROOM'::character varying)::text])))
);


--
-- Name: unavailability_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unavailability_periods (
    period_id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    reason character varying(255),
    CONSTRAINT unavailability_periods_check CHECK ((end_date >= start_date))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    user_id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name character varying(100) NOT NULL,
    email character varying(150) NOT NULL,
    password_hash character varying(255) NOT NULL,
    phone character varying(20),
    role character varying(20) NOT NULL,
    department character varying(100),
    laboratory character varying(100),
    academic_title character varying(50),
    office character varying(100),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_role_check CHECK (((role)::text = ANY (ARRAY[('RESEARCHER'::character varying)::text, ('ADMINISTRATOR'::character varying)::text])))
);


--
-- Name: approval_decisions approval_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_pkey PRIMARY KEY (decision_id);


--
-- Name: approval_decisions approval_decisions_reservation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_reservation_id_key UNIQUE (reservation_id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (audit_id);


--
-- Name: availability_windows availability_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability_windows
    ADD CONSTRAINT availability_windows_pkey PRIMARY KEY (window_id);


--
-- Name: availability_windows availability_windows_resource_id_day_of_week_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability_windows
    ADD CONSTRAINT availability_windows_resource_id_day_of_week_key UNIQUE (resource_id, day_of_week);


--
-- Name: locations locations_building_room_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_building_room_key UNIQUE (building, room);


--
-- Name: locations locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_pkey PRIMARY KEY (location_id);


--
-- Name: reservations no_overlapping_reservations; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT no_overlapping_reservations EXCLUDE USING gist (resource_id WITH =, tstzrange(start_time, end_time, '[)'::text) WITH &&) WHERE (((status)::text = ANY (ARRAY[('PENDING'::character varying)::text, ('APPROVED'::character varying)::text, ('ACTIVE'::character varying)::text])));


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (notification_id);


--
-- Name: reservations reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_pkey PRIMARY KEY (reservation_id);


--
-- Name: resources resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (resource_id);


--
-- Name: unavailability_periods unavailability_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unavailability_periods
    ADD CONSTRAINT unavailability_periods_pkey PRIMARY KEY (period_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: idx_audit_logs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_created ON public.audit_logs USING btree (created_at);


--
-- Name: idx_notifications_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id) WHERE (read_at IS NULL);


--
-- Name: idx_reservations_researcher; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservations_researcher ON public.reservations USING btree (researcher_id);


--
-- Name: idx_reservations_resource_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservations_resource_start ON public.reservations USING btree (resource_id, start_time);


--
-- Name: idx_reservations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservations_status ON public.reservations USING btree (status);


--
-- Name: idx_resources_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resources_location ON public.resources USING btree (location_id);


--
-- Name: idx_resources_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resources_type ON public.resources USING btree (type);


--
-- Name: approval_decisions trg_decisions_administrator; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_decisions_administrator BEFORE INSERT OR UPDATE OF administrator_id ON public.approval_decisions FOR EACH ROW EXECUTE FUNCTION public.fn_check_administrator_role();


--
-- Name: reservations trg_reservations_researcher; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reservations_researcher BEFORE INSERT OR UPDATE OF researcher_id ON public.reservations FOR EACH ROW EXECUTE FUNCTION public.fn_check_researcher_role();


--
-- Name: approval_decisions approval_decisions_administrator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_administrator_id_fkey FOREIGN KEY (administrator_id) REFERENCES public.users(user_id) ON DELETE RESTRICT;


--
-- Name: approval_decisions approval_decisions_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(reservation_id) ON DELETE CASCADE;


--
-- Name: audit_logs audit_logs_administrator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_administrator_id_fkey FOREIGN KEY (administrator_id) REFERENCES public.users(user_id) ON DELETE RESTRICT;


--
-- Name: availability_windows availability_windows_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability_windows
    ADD CONSTRAINT availability_windows_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(resource_id) ON DELETE CASCADE;


--
-- Name: notifications notifications_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(reservation_id) ON DELETE SET NULL;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: reservations reservations_researcher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_researcher_id_fkey FOREIGN KEY (researcher_id) REFERENCES public.users(user_id) ON DELETE RESTRICT;


--
-- Name: reservations reservations_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(resource_id) ON DELETE RESTRICT;


--
-- Name: resources resources_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(location_id) ON DELETE RESTRICT;


--
-- Name: resources resources_responsible_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_responsible_admin_id_fkey FOREIGN KEY (responsible_admin_id) REFERENCES public.users(user_id) ON DELETE SET NULL;


--
-- Name: unavailability_periods unavailability_periods_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unavailability_periods
    ADD CONSTRAINT unavailability_periods_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(resource_id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
